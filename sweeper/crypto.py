"""Pluggable envelope for before/after payloads in the audit trail (R1.6.5).

Deliberately not implementing a cipher here. Hand-rolled crypto in a system
whose whole value is trustworthy audit evidence would be a bad trade; wire a
KMS-backed implementation in before storing production PII.
"""

from __future__ import annotations

import json
from typing import Any, Protocol


class Cipher(Protocol):
    def encrypt(self, plaintext: bytes) -> bytes: ...
    def decrypt(self, ciphertext: bytes) -> bytes: ...


class NullCipher:
    """Development default: stores payloads as-is.

    Production deployments must replace this (see R1.8.2). `Engine` records
    which cipher was used on the run so an unencrypted run is visible.
    """

    name = "null"

    def encrypt(self, plaintext: bytes) -> bytes:
        return plaintext

    def decrypt(self, ciphertext: bytes) -> bytes:
        return ciphertext


def seal(cipher: Cipher, value: Any) -> bytes | None:
    if value is None:
        return None
    return cipher.encrypt(json.dumps(value, sort_keys=True, default=str).encode("utf-8"))


def unseal(cipher: Cipher, blob: bytes | None) -> Any:
    if blob is None:
        return None
    return json.loads(cipher.decrypt(blob).decode("utf-8"))
