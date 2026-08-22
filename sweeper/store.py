"""Persistence for specs, runs, checkpoints, audit events, DLQ and review tasks.

SQLite-backed. Postgres is the production target (docs/data-model.sql); the
SQL here is kept plain enough to port, and every statement goes through this
module so the swap is one file.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA_FILE = Path(__file__).resolve().parent / "schema_sqlite.sql"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def new_id() -> str:
    return str(uuid.uuid4())


@dataclass
class Counters:
    """Per-run tallies (R1.6.1). Held in memory, flushed at checkpoints."""

    scanned: int = 0
    matched: int = 0
    acted: int = 0
    skipped: int = 0
    failed: int = 0
    reviewed: int = 0
    extra: dict[str, int] = field(default_factory=dict)

    def bump(self, name: str, by: int = 1) -> None:
        if hasattr(self, name):
            setattr(self, name, getattr(self, name) + by)
        else:
            self.extra[name] = self.extra.get(name, 0) + by

    def as_dict(self) -> dict[str, int]:
        out = {
            "scanned": self.scanned,
            "matched": self.matched,
            "acted": self.acted,
            "skipped": self.skipped,
            "failed": self.failed,
            "reviewed": self.reviewed,
        }
        out.update(self.extra)
        return out

    def dlq_rate_pct(self) -> float:
        return 0.0 if self.scanned == 0 else 100.0 * self.failed / self.scanned


class Store:
    """Thread-safe SQLite store.

    One connection guarded by a lock. That is the right trade at this scale:
    sweeps are I/O-bound on the source, not on the local database, and a single
    writer removes a whole class of SQLite concurrency failure.
    """

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self.init_schema()

    def init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(SCHEMA_FILE.read_text(encoding="utf-8"))
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    # ------------------------------------------------------------ specs

    def put_spec(self, body: dict[str, Any], created_by: str) -> int:
        """Store a spec, returning its version.

        Specs are immutably versioned (R1.1.2). Storing a byte-identical body
        returns the existing version rather than churning a new one.
        """
        from .spec import spec_hash

        digest = spec_hash(body)
        spec_id = body["id"]
        with self._tx() as conn:
            row = conn.execute(
                "SELECT version FROM sweep_spec WHERE spec_id = ? AND body_hash = ?",
                (spec_id, digest),
            ).fetchone()
            if row:
                return int(row["version"])
            latest = conn.execute(
                "SELECT COALESCE(MAX(version), 0) AS v FROM sweep_spec WHERE spec_id = ?",
                (spec_id,),
            ).fetchone()["v"]
            version = int(latest) + 1
            conn.execute(
                "INSERT INTO sweep_spec (spec_id, version, mode, owner, body, body_hash,"
                " active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (
                    spec_id,
                    version,
                    body["mode"],
                    body["owner"],
                    json.dumps(body, sort_keys=True),
                    digest,
                    created_by,
                    utcnow(),
                ),
            )
            return version

    def get_spec(self, spec_id: str, version: int | None = None) -> tuple[dict[str, Any], int]:
        with self._lock:
            if version is None:
                row = self._conn.execute(
                    "SELECT body, version FROM sweep_spec WHERE spec_id = ?"
                    " ORDER BY version DESC LIMIT 1",
                    (spec_id,),
                ).fetchone()
            else:
                row = self._conn.execute(
                    "SELECT body, version FROM sweep_spec WHERE spec_id = ? AND version = ?",
                    (spec_id, version),
                ).fetchone()
        if row is None:
            raise KeyError(f"no such spec: {spec_id}@{version or 'latest'}")
        return json.loads(row["body"]), int(row["version"])

    # ------------------------------------------------------------- runs

    def create_run(
        self,
        *,
        spec_id: str,
        spec_version: int,
        spec_hash: str,
        mode: str,
        dry_run: bool,
        initiated_by: str,
        trigger: str = "manual",
        based_on_run_id: str | None = None,
        cipher: str = "null",
    ) -> str:
        run_id = new_id()
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO sweep_run (run_id, spec_id, spec_version, spec_hash, mode, dry_run,"
                " based_on_run_id, state, initiated_by, trigger, cipher, counters)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, '{}')",
                (
                    run_id,
                    spec_id,
                    spec_version,
                    spec_hash,
                    mode,
                    int(dry_run),
                    based_on_run_id,
                    initiated_by,
                    trigger,
                    cipher,
                ),
            )
        return run_id

    def get_run(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sweep_run WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"no such run: {run_id}")
        out = dict(row)
        out["counters"] = json.loads(out["counters"] or "{}")
        out["dry_run"] = bool(out["dry_run"])
        return out

    def start_run(self, run_id: str) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE sweep_run SET state = 'running', started_at = ? WHERE run_id = ?",
                (utcnow(), run_id),
            )

    def finish_run(self, run_id: str, state: str, counters: Counters, error: str | None = None) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE sweep_run SET state = ?, finished_at = ?, counters = ?, error = ?"
                " WHERE run_id = ?",
                (state, utcnow(), json.dumps(counters.as_dict()), error, run_id),
            )

    def save_counters(self, run_id: str, counters: Counters) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE sweep_run SET counters = ? WHERE run_id = ?",
                (json.dumps(counters.as_dict()), run_id),
            )

    def request_cancel(self, run_id: str, by: str) -> None:
        """Kill switch (R1.5.5). Workers observe this between batches."""
        with self._tx() as conn:
            conn.execute(
                "UPDATE sweep_run SET cancel_requested_at = ?, cancel_requested_by = ?"
                " WHERE run_id = ?",
                (utcnow(), by, run_id),
            )

    def cancel_requested(self, run_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT cancel_requested_at FROM sweep_run WHERE run_id = ?", (run_id,)
            ).fetchone()
        return bool(row and row["cancel_requested_at"])

    def list_runs(self, spec_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        sql = "SELECT * FROM sweep_run"
        args: tuple[Any, ...] = ()
        if spec_id:
            sql += " WHERE spec_id = ?"
            args = (spec_id,)
        sql += " ORDER BY COALESCE(started_at, run_id) DESC LIMIT ?"
        with self._lock:
            rows = self._conn.execute(sql, (*args, limit)).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["counters"] = json.loads(item["counters"] or "{}")
            item["dry_run"] = bool(item["dry_run"])
            out.append(item)
        return out

    # ------------------------------------------------------ checkpoints

    def save_checkpoint(self, run_id: str, partition: str, cursor: Any, records_done: int) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO sweep_checkpoint (run_id, partition, cursor, records_done, updated_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(run_id, partition) DO UPDATE SET"
                " cursor = excluded.cursor, records_done = excluded.records_done,"
                " updated_at = excluded.updated_at",
                (run_id, partition, json.dumps(cursor), records_done, utcnow()),
            )

    def get_checkpoint(self, run_id: str, partition: str) -> tuple[Any, int] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT cursor, records_done FROM sweep_checkpoint"
                " WHERE run_id = ? AND partition = ?",
                (run_id, partition),
            ).fetchone()
        return (json.loads(row["cursor"]), int(row["records_done"])) if row else None

    def get_watermark(self, spec_id: str, partition: str) -> Any | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT watermark FROM sweep_watermark WHERE spec_id = ? AND partition = ?",
                (spec_id, partition),
            ).fetchone()
        return json.loads(row["watermark"]) if row else None

    def set_watermark(self, spec_id: str, partition: str, watermark: Any, run_id: str) -> None:
        """Advance only after the covering batch is durably committed (R1.3.2)."""
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO sweep_watermark (spec_id, partition, watermark, advanced_by, updated_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(spec_id, partition) DO UPDATE SET"
                " watermark = excluded.watermark, advanced_by = excluded.advanced_by,"
                " updated_at = excluded.updated_at",
                (spec_id, partition, json.dumps(watermark), run_id, utcnow()),
            )

    # ------------------------------------------------------ audit trail

    def append_event(
        self,
        *,
        run_id: str,
        system: str,
        source_record_id: str,
        decision: str,
        action: str,
        applied: bool,
        idempotency_key: str,
        reason: str | None = None,
        before: bytes | None = None,
        after: bytes | None = None,
    ) -> int:
        with self._tx() as conn:
            cur = conn.execute(
                "INSERT INTO record_event (run_id, system, source_record_id, decision, reason,"
                " action, applied, before, after, idempotency_key, occurred_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    system,
                    source_record_id,
                    decision,
                    reason,
                    action,
                    int(applied),
                    before,
                    after,
                    idempotency_key,
                    utcnow(),
                ),
            )
        return int(cur.lastrowid)

    def events(self, run_id: str, decision: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM record_event WHERE run_id = ?"
        args: list[Any] = [run_id]
        if decision:
            sql += " AND decision = ?"
            args.append(decision)
        sql += " ORDER BY event_id"
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, args).fetchall()]

    # ---------------------------------------------------- idempotency

    def reserve_mutation(self, key: str, run_id: str) -> bool:
        """Claim a mutation key. False means it is already claimed (R1.4.3)."""
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO applied_mutation (idempotency_key, run_id, state, reserved_at)"
                    " VALUES (?, ?, 'reserved', ?)",
                    (key, run_id, utcnow()),
                )
                self._conn.commit()
                return True
            except sqlite3.IntegrityError:
                self._conn.rollback()
                return False

    def complete_mutation(self, key: str) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE applied_mutation SET state = 'applied', applied_at = ?"
                " WHERE idempotency_key = ?",
                (utcnow(), key),
            )

    def release_mutation(self, key: str) -> None:
        """Drop a reservation whose mutation failed, so a replay can retry it."""
        with self._tx() as conn:
            conn.execute(
                "DELETE FROM applied_mutation WHERE idempotency_key = ? AND state = 'reserved'",
                (key,),
            )

    def mutation_state(self, key: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT state FROM applied_mutation WHERE idempotency_key = ?", (key,)
            ).fetchone()
        return row["state"] if row else None

    # ------------------------------------------------------------- DLQ

    def add_dlq(
        self,
        run_id: str,
        source_record_id: str | None,
        payload: Any,
        error: str,
        error_class: str | None = None,
    ) -> int:
        now = utcnow()
        with self._tx() as conn:
            cur = conn.execute(
                "INSERT INTO dead_letter (run_id, source_record_id, payload, error, error_class,"
                " attempts, first_seen_at, last_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                (run_id, source_record_id, json.dumps(payload, default=str), error, error_class, now, now),
            )
        return int(cur.lastrowid)

    def dlq(self, run_id: str, unresolved_only: bool = True) -> list[dict[str, Any]]:
        sql = "SELECT * FROM dead_letter WHERE run_id = ?"
        if unresolved_only:
            sql += " AND resolved_at IS NULL"
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql + " ORDER BY dlq_id", (run_id,)).fetchall()]

    def resolve_dlq(self, dlq_id: int, replayed_run_id: str | None = None) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE dead_letter SET resolved_at = ?, replayed_run_id = ? WHERE dlq_id = ?",
                (utcnow(), replayed_run_id, dlq_id),
            )

    # ------------------------------------------------------- approvals

    def add_approval(
        self, run_id: str, spec_hash: str, approver: str, decision: str, comment: str | None = None
    ) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO approval (run_id, spec_hash, approver, decision, comment, decided_at)"
                " VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(run_id, approver) DO UPDATE SET"
                " decision = excluded.decision, comment = excluded.comment,"
                " spec_hash = excluded.spec_hash, decided_at = excluded.decided_at",
                (run_id, spec_hash, approver, decision, comment, utcnow()),
            )

    def approvals(self, run_id: str, spec_hash: str) -> list[dict[str, Any]]:
        """Approvals are void if the spec body changed underneath them (R1.5.7)."""
        with self._lock:
            return [
                dict(r)
                for r in self._conn.execute(
                    "SELECT * FROM approval WHERE run_id = ? AND spec_hash = ?", (run_id, spec_hash)
                ).fetchall()
            ]

    # ----------------------------------------------------- review queue

    def add_review_task(
        self, run_id: str, rule_id: str, score: float | None, candidates: Any, proposal: Any
    ) -> int:
        with self._tx() as conn:
            cur = conn.execute(
                "INSERT INTO review_task (run_id, rule_id, score, candidates, proposal, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    rule_id,
                    score,
                    json.dumps(candidates, default=str),
                    json.dumps(proposal, default=str),
                    utcnow(),
                ),
            )
        return int(cur.lastrowid)

    def review_tasks(self, run_id: str | None = None, state: str = "open") -> list[dict[str, Any]]:
        sql = "SELECT * FROM review_task WHERE state = ?"
        args: list[Any] = [state]
        if run_id:
            sql += " AND run_id = ?"
            args.append(run_id)
        with self._lock:
            rows = self._conn.execute(sql + " ORDER BY task_id", args).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["candidates"] = json.loads(item["candidates"])
            item["proposal"] = json.loads(item["proposal"])
            out.append(item)
        return out

    def resolve_review_task(self, task_id: int, state: str, reviewer: str) -> None:
        with self._tx() as conn:
            conn.execute(
                "UPDATE review_task SET state = ?, reviewer = ?, reviewed_at = ? WHERE task_id = ?",
                (state, reviewer, utcnow(), task_id),
            )

    # ------------------------------------------- mode A change detection

    def content_hash_for(self, system: str, source_record_id: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT content_hash FROM content_seen WHERE system = ? AND source_record_id = ?",
                (system, source_record_id),
            ).fetchone()
        return row["content_hash"] if row else None

    def remember_content(
        self,
        system: str,
        source_record_id: str,
        content_hash: str,
        landing_ref: str | None,
        parser_version: str | None,
    ) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO content_seen (system, source_record_id, content_hash, landing_ref,"
                " parser_version, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(system, source_record_id) DO UPDATE SET"
                " content_hash = excluded.content_hash, landing_ref = excluded.landing_ref,"
                " parser_version = excluded.parser_version, last_seen_at = excluded.last_seen_at",
                (system, source_record_id, content_hash, landing_ref, parser_version, utcnow()),
            )
