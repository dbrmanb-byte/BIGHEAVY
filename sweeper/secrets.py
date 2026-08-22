"""Credential resolution (R1.2.3).

Specs reference credentials as `vault://path#key`; nothing secret is ever
stored in a spec body. The default resolver reads the environment, which is
the right shape for a container deployment and swaps cleanly for a real vault
client.
"""

from __future__ import annotations

import os
import re
from typing import Protocol
from urllib.parse import urlsplit

from .errors import SpecInvalid


class SecretResolver(Protocol):
    def resolve(self, ref: str) -> str: ...


def env_var_for(ref: str) -> str:
    parts = urlsplit(ref)
    if parts.scheme != "vault":
        raise SpecInvalid(f"credential reference must start with vault:// — got {ref!r}")
    path = f"{parts.netloc}{parts.path}".strip("/")
    name = f"SWEEPER_SECRET_{path}_{parts.fragment}" if parts.fragment else f"SWEEPER_SECRET_{path}"
    return re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")


class EnvSecrets:
    """Reads `vault://a/b#c` from `SWEEPER_SECRET_A_B_C`."""

    def __init__(self, allow_missing: bool = False) -> None:
        self.allow_missing = allow_missing

    def resolve(self, ref: str) -> str:
        name = env_var_for(ref)
        value = os.environ.get(name)
        if value is None:
            if self.allow_missing:
                return ""
            raise SpecInvalid(
                f"credential {ref} is not available (expected environment variable {name})"
            )
        return value


class DictSecrets:
    """For tests and local runs."""

    def __init__(self, values: dict[str, str]) -> None:
        self.values = values

    def resolve(self, ref: str) -> str:
        if ref not in self.values:
            raise SpecInvalid(f"credential {ref} is not available")
        return self.values[ref]
