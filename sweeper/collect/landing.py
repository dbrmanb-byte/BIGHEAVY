"""Content-addressed landing zone (A1).

The raw payload is stored before parsing, keyed by its own hash. A parser bug
is then fixable by reparsing what is already on disk instead of re-crawling —
which is the difference between a one-hour fix and re-annoying every source.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def content_hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


@dataclass
class LandingRef:
    digest: str
    path: Path

    def __str__(self) -> str:
        return f"sha256:{self.digest}"


class LandingZone:
    """Filesystem-backed. Swap for object storage by replacing put/get."""

    def __init__(self, root: str | Path, retention_days: int | None = None) -> None:
        self.root = Path(root)
        self.retention_days = retention_days
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, digest: str) -> Path:
        return self.root / digest[:2] / digest[2:4] / digest

    def put(self, raw: bytes, meta: dict[str, Any] | None = None) -> LandingRef:
        digest = content_hash(raw)
        path = self.path_for(digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            # Write-then-rename so a crash never leaves a truncated payload
            # that would later be trusted as complete.
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(raw)
            tmp.replace(path)
        if meta:
            path.with_suffix(".meta.json").write_text(
                json.dumps(meta, sort_keys=True, default=str), encoding="utf-8"
            )
        return LandingRef(digest=digest, path=path)

    def get(self, digest: str) -> bytes:
        digest = digest.split(":", 1)[-1]
        return self.path_for(digest).read_bytes()

    def has(self, digest: str) -> bool:
        return self.path_for(digest.split(":", 1)[-1]).exists()
