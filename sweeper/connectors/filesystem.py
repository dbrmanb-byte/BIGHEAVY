"""Filesystem source for mode A: harvest files from a directory tree.

Useful on its own (log drops, export dumps) and it makes the collect pipeline
runnable offline, which matters for tests and demos.
"""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path
from typing import Any

from ..errors import RecordError
from . import Batch, Capabilities, Connector, Record, register


@register("filesystem")
class FilesystemConnector(Connector):
    """Config: root (dir), glob (default '*'), partition_depth (default 0)."""

    def __init__(self, config: dict[str, Any] | None = None, auth: Any = None) -> None:
        super().__init__(config, auth)
        self.root = Path(self.config.get("root", ".")).resolve()
        self.glob = self.config.get("glob", "*")
        self.partition_depth = int(self.config.get("partition_depth", 0))

    def capabilities(self) -> Capabilities:
        return Capabilities(incremental=True)

    def _files(self) -> list[Path]:
        out: list[Path] = []
        for dirpath, _dirs, files in os.walk(self.root):
            for fname in files:
                if fnmatch.fnmatch(fname, self.glob):
                    out.append(Path(dirpath) / fname)
        return sorted(out)

    def _partition_of(self, path: Path) -> str:
        if self.partition_depth <= 0:
            return "default"
        parts = path.relative_to(self.root).parts[: self.partition_depth]
        return "/".join(parts) if parts else "default"

    def partitions(self, scope: dict[str, Any]) -> list[str]:
        return sorted({self._partition_of(p) for p in self._files()}) or ["default"]

    def enumerate(
        self,
        partition: str,
        cursor: Any,
        batch_size: int,
        scope: dict[str, Any],
        watermark: Any = None,
    ) -> Batch:
        files = [p for p in self._files() if self._partition_of(p) == partition]
        if watermark is not None and scope.get("watermark_field") == "mtime":
            files = [p for p in files if p.stat().st_mtime > float(watermark)]
        offset = int(cursor or 0)
        window = files[offset : offset + batch_size]
        records = [
            Record(
                id=str(p.relative_to(self.root)),
                cursor=offset + i + 1,
                meta={"path": str(p), "mtime": p.stat().st_mtime},
            )
            for i, p in enumerate(window)
        ]
        nxt = offset + len(window)
        return Batch(records=records, next_cursor=nxt, exhausted=nxt >= len(files))

    def read(self, record: Record) -> Record:
        try:
            record.raw = Path(record.meta["path"]).read_bytes()
        except OSError as exc:
            raise RecordError(f"cannot read {record.id}: {exc}") from exc
        return record
