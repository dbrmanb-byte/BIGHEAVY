"""Sweep specs: parsing, schema validation, canonical hashing (R1.1.1-R1.1.4)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .errors import SpecInvalid

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "docs" / "sweep-spec.schema.json"


@lru_cache(maxsize=1)
def load_schema(path: str | None = None) -> dict[str, Any]:
    with open(path or SCHEMA_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def canonical_bytes(body: dict[str, Any]) -> bytes:
    """Stable serialisation, so an unchanged spec always hashes the same."""
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")


def spec_hash(body: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bytes(body)).hexdigest()


def validate_body(body: dict[str, Any]) -> None:
    """Schema-validate a spec, reporting every problem rather than the first."""
    try:
        import jsonschema
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise SpecInvalid("jsonschema is required to validate specs") from exc

    validator = jsonschema.Draft202012Validator(load_schema())
    problems = [
        f"{'/'.join(str(p) for p in err.path) or '<root>'}: {err.message}"
        for err in sorted(validator.iter_errors(body), key=lambda e: list(e.path))
    ]
    if problems:
        raise SpecInvalid(f"spec {body.get('id', '<unnamed>')} failed validation", problems)

    # Secrets belong in a vault, never in the spec body (R1.2.3). The schema
    # constrains `auth_ref`, but a config block could still smuggle one in.
    _reject_inline_secrets(body.get("source", {}).get("config", {}), "source/config")
    dest = body.get("action", {}).get("destination")
    if isinstance(dest, dict):
        _reject_inline_secrets(dest, "action/destination")


_SECRET_HINTS = ("password", "secret", "token", "api_key", "apikey", "private_key")


def _reject_inline_secrets(obj: Any, where: str) -> None:
    if not isinstance(obj, dict):
        return
    for key, value in obj.items():
        lowered = key.lower()
        if any(hint in lowered for hint in _SECRET_HINTS):
            if not (isinstance(value, str) and value.startswith("vault://")):
                raise SpecInvalid(
                    f"inline secret in {where}/{key}: use a vault:// reference (R1.2.3)"
                )
        _reject_inline_secrets(value, f"{where}/{key}")


@dataclass(frozen=True)
class Spec:
    """A validated sweep spec bound to a stored version."""

    body: dict[str, Any]
    version: int = 0

    def __post_init__(self) -> None:
        validate_body(self.body)

    @classmethod
    def from_file(cls, path: str | Path, version: int = 0) -> "Spec":
        with open(path, encoding="utf-8") as fh:
            return cls(json.load(fh), version=version)

    @property
    def id(self) -> str:
        return self.body["id"]

    @property
    def mode(self) -> str:
        return self.body["mode"]

    @property
    def owner(self) -> str:
        return self.body["owner"]

    @property
    def hash(self) -> str:
        return spec_hash(self.body)

    @property
    def source(self) -> dict[str, Any]:
        return self.body["source"]

    @property
    def scope(self) -> dict[str, Any]:
        return self.body["scope"]

    @property
    def limits(self) -> dict[str, Any]:
        return self.body["limits"]

    @property
    def safety(self) -> dict[str, Any]:
        return self.body["safety"]

    @property
    def action(self) -> dict[str, Any]:
        return self.body["action"]

    @property
    def batch_size(self) -> int:
        return int(self.limits["batch_size"])

    @property
    def concurrency(self) -> int:
        return int(self.limits["concurrency"])

    @property
    def rate_per_second(self) -> float | None:
        value = self.limits.get("rate_per_second")
        return float(value) if value else None

    @property
    def max_records_matched(self) -> int | None:
        value = self.limits.get("max_records_matched")
        return int(value) if value else None

    @property
    def max_mutations(self) -> int | None:
        value = self.limits.get("max_mutations")
        return int(value) if value else None

    @property
    def max_dlq_rate_pct(self) -> float:
        return float(self.limits.get("max_dlq_rate_pct", 5))

    @property
    def is_incremental(self) -> bool:
        return self.scope["strategy"] == "incremental"

    def describe(self) -> str:
        return f"{self.id}@v{self.version} ({self.mode})"
