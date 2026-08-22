"""Connector interface and registry (R1.2.1, R1.2.2).

Connectors know how to talk to one kind of system. They do not know about
sweep modes: the engine decides what to do, the connector declares what it is
able to do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from ..errors import CapabilityError, SpecInvalid


@dataclass(frozen=True)
class Capabilities:
    """What a connector supports. The engine refuses specs that exceed this."""

    incremental: bool = False
    filter_pushdown: bool = False
    writable: bool = False
    field_update: bool = False
    hard_delete: bool = False
    transactional_batch: bool = False


@dataclass
class Record:
    """One unit of work pulled from a source."""

    id: str
    payload: dict[str, Any] | None = None
    raw: bytes | None = None
    cursor: Any = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class Batch:
    records: list[Record]
    next_cursor: Any
    exhausted: bool


@dataclass
class Mutation:
    kind: str  # 'update' | 'delete' | 'upsert'
    record_id: str
    values: dict[str, Any] | None = None


class Connector:
    """Base class. Subclasses override what their `capabilities()` claims."""

    name = "base"

    def __init__(self, config: dict[str, Any] | None = None, auth: Any = None) -> None:
        self.config = config or {}
        self.auth = auth

    def capabilities(self) -> Capabilities:
        return Capabilities()

    def partitions(self, scope: dict[str, Any]) -> list[str]:
        """Units of parallel enumeration (R1.3.3). Default: one partition."""
        return ["default"]

    def enumerate(
        self,
        partition: str,
        cursor: Any,
        batch_size: int,
        scope: dict[str, Any],
        watermark: Any = None,
    ) -> Batch:
        raise NotImplementedError

    def read(self, record: Record) -> Record:
        """Hydrate a record. Sources that enumerate full rows return it as-is."""
        return record

    def fetch(self, record_id: str) -> Record:
        """Read one record by id, outside of enumeration."""
        return self.read(Record(id=record_id))

    def apply(self, mutation: Mutation) -> None:
        raise CapabilityError(f"connector {self.name} is not writable")

    def upsert(self, rows: Iterable[dict[str, Any]], key: list[str], policy: str) -> int:
        raise CapabilityError(f"connector {self.name} is not a destination")

    def close(self) -> None:
        pass


_REGISTRY: dict[str, type[Connector]] = {}


def register(name: str) -> Callable[[type[Connector]], type[Connector]]:
    def wrap(cls: type[Connector]) -> type[Connector]:
        cls.name = name
        _REGISTRY[name] = cls
        return cls

    return wrap


def available() -> list[str]:
    return sorted(_REGISTRY)


def build(name: str, config: dict[str, Any] | None = None, auth: Any = None) -> Connector:
    """Instantiate a connector, or fail the spec before any record is touched."""
    if name not in _REGISTRY:
        raise SpecInvalid(
            f"unknown connector {name!r}; available: {', '.join(available()) or 'none'}"
        )
    return _REGISTRY[name](config or {}, auth)


def require(caps: Capabilities, **needed: bool) -> None:
    """Assert connector capabilities, naming every gap at once (R1.2.2)."""
    missing = [k for k, want in needed.items() if want and not getattr(caps, k, False)]
    if missing:
        raise CapabilityError("connector lacks required capabilities: " + ", ".join(missing))


# Importing the concrete connectors populates the registry.
from . import filesystem, http_listing, memory, sqlite_table  # noqa: E402,F401
