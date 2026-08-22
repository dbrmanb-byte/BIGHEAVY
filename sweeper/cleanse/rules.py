"""Versioned cleansing rules (C1).

Rules are addressed by id *and* version. Changing behaviour means a new
version, because C8 requires precision/recall to be re-measured against the
golden dataset before the change goes live — and that comparison is
meaningless if a rule can mutate in place.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

FieldRule = Callable[[Any, dict[str, Any]], Any]
ValidateRule = Callable[[Any, dict[str, Any]], str | None]

_FIELD_RULES: dict[tuple[str, str], FieldRule] = {}
_VALIDATE_RULES: dict[tuple[str, str], ValidateRule] = {}
# Rules the matcher owns rather than the field pipeline.
_MERGE_RULES: set[tuple[str, str]] = set()


@dataclass
class RuleSpec:
    id: str
    type: str
    version: str
    fields: list[str] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True

    @classmethod
    def from_dict(cls, body: dict[str, Any]) -> "RuleSpec":
        return cls(
            id=body["id"],
            type=body["type"],
            version=body["version"],
            fields=list(body.get("fields") or []),
            config=dict(body.get("config") or {}),
            enabled=bool(body.get("enabled", True)),
        )


class UnknownRule(KeyError):
    pass


def field_rule(rule_id: str, version: str) -> Callable[[FieldRule], FieldRule]:
    def wrap(fn: FieldRule) -> FieldRule:
        _FIELD_RULES[(rule_id, version)] = fn
        return fn

    return wrap


def validate_rule(rule_id: str, version: str) -> Callable[[ValidateRule], ValidateRule]:
    def wrap(fn: ValidateRule) -> ValidateRule:
        _VALIDATE_RULES[(rule_id, version)] = fn
        return fn

    return wrap


def merge_rule(rule_id: str, version: str) -> None:
    _MERGE_RULES.add((rule_id, version))


def get_rule(spec: RuleSpec) -> FieldRule | ValidateRule | None:
    key = (spec.id, spec.version)
    if key in _MERGE_RULES:
        return None
    if spec.type == "validate":
        try:
            return _VALIDATE_RULES[key]
        except KeyError:
            raise UnknownRule(f"no validate rule {spec.id}@{spec.version}") from None
    try:
        return _FIELD_RULES[key]
    except KeyError:
        raise UnknownRule(f"no field rule {spec.id}@{spec.version}") from None


def registered_rules() -> list[str]:
    return sorted(
        {f"{i}@{v} ({kind})"
         for kind, table in (("field", _FIELD_RULES), ("validate", _VALIDATE_RULES))
         for (i, v) in table}
        | {f"{i}@{v} (merge)" for (i, v) in _MERGE_RULES}
    )


def apply_rules(row: dict[str, Any], rules: list[RuleSpec]) -> tuple[dict[str, Any], list[str]]:
    """Run the rule chain over one row.

    Returns the new row and any validation problems. Validation never blocks
    normalisation — a record with a malformed email still gets its whitespace
    trimmed, and the problem is reported alongside.
    """
    out = dict(row)
    problems: list[str] = []
    for spec in rules:
        if not spec.enabled:
            continue
        fn = get_rule(spec)
        if fn is None:  # merge rules are handled by the Matcher
            continue
        targets = spec.fields or [k for k in out if not k.startswith("_")]
        for name in targets:
            if name not in out:
                continue
            value = out[name]
            if spec.type == "validate":
                problem = fn(value, spec.config)
                if problem:
                    problems.append(f"{spec.id}: {name}: {problem}")
            else:
                out[name] = fn(value, spec.config)
    return out, problems


# ----------------------------------------------------------- built-ins

@field_rule("trim-whitespace", "1.0.0")
def _trim(value: Any, config: dict[str, Any]) -> Any:
    if not isinstance(value, str):
        return value
    return re.sub(r"\s+", " ", value).strip()


@field_rule("email-lowercase", "1.0.0")
def _email_lower(value: Any, config: dict[str, Any]) -> Any:
    if not isinstance(value, str) or "@" not in value:
        return value
    local, _, domain = value.rpartition("@")
    # Only the domain is case-insensitive per RFC 5321; lowering the local part
    # is a normalisation choice, so it is opt-in.
    local = local.lower() if config.get("lowercase_local", True) else local
    return f"{local}@{domain.lower()}"


_E164_REGIONS = {"US": "1", "CA": "1", "GB": "44", "AU": "61"}


@field_rule("phone-e164", "2.1.0")
def _phone_e164(value: Any, config: dict[str, Any]) -> Any:
    if not isinstance(value, str) or not value.strip():
        return value
    if value.strip().startswith("+"):
        digits = re.sub(r"\D", "", value)
        return f"+{digits}" if digits else value
    region = str(config.get("default_region", "US")).upper()
    code = _E164_REGIONS.get(region)
    if code is None:
        return value
    digits = re.sub(r"\D", "", value)
    if not digits:
        return value
    if digits.startswith(code) and len(digits) > 10:
        return f"+{digits}"
    if region in ("US", "CA"):
        if len(digits) == 10:
            return f"+1{digits}"
        if len(digits) == 11 and digits.startswith("1"):
            return f"+{digits}"
        return value  # not a recognisable NANP number; leave it for review
    return f"+{code}{digits.lstrip('0')}"


_USPS_SUFFIXES = {
    "STREET": "ST", "AVENUE": "AVE", "ROAD": "RD", "BOULEVARD": "BLVD", "DRIVE": "DR",
    "LANE": "LN", "COURT": "CT", "PLACE": "PL", "TERRACE": "TER", "PARKWAY": "PKWY",
    "CIRCLE": "CIR", "HIGHWAY": "HWY", "SUITE": "STE", "APARTMENT": "APT",
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
}


@field_rule("postal-usps", "1.4.0")
def _postal_usps(value: Any, config: dict[str, Any]) -> Any:
    if not isinstance(value, str) or not value.strip():
        return value
    text = re.sub(r"\s+", " ", value).strip().upper()
    if re.fullmatch(r"\d{5}(-?\d{4})?", text.replace(" ", "")):
        digits = text.replace("-", "").replace(" ", "")
        return digits[:5] if config.get("zip5_only", True) else f"{digits[:5]}-{digits[5:]}"
    text = text.replace(".", "").replace(",", "")
    return " ".join(_USPS_SUFFIXES.get(word, word) for word in text.split())


_EMAIL_RE = re.compile(r"^[^@\s]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z]{2,})+$")


@validate_rule("email-deliverable", "1.2.0")
def _email_deliverable(value: Any, config: dict[str, Any]) -> str | None:
    """Syntax and domain-shape check only.

    Deliberately no DNS or SMTP probe: a cleansing sweep that emits network
    traffic per record is a rate-limit incident waiting to happen, and MX
    presence does not prove deliverability anyway.
    """
    if value in (None, ""):
        return "empty" if config.get("required") else None
    if not isinstance(value, str) or not _EMAIL_RE.match(value):
        return f"not a valid address: {value!r}"
    domain = value.rpartition("@")[2].lower()
    if domain in set(config.get("blocked_domains", ["example.com", "test.invalid"])):
        return f"non-deliverable domain: {domain}"
    return None


merge_rule("contact-merge", "3.0.0")
