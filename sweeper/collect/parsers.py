"""Versioned parser registry (A2).

Every parsed record carries the parser name and version that produced it, so a
fix can be backfilled over the landing zone rather than re-collected.
"""

from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from typing import Any, Callable

Parser = Callable[[bytes, dict[str, Any]], list[dict[str, Any]]]

_PARSERS: dict[tuple[str, str], Parser] = {}


class ParseError(Exception):
    """Raised for a payload the parser cannot handle. Routed to the DLQ."""


def register_parser(name: str, version: str) -> Callable[[Parser], Parser]:
    def wrap(fn: Parser) -> Parser:
        _PARSERS[(name, version)] = fn
        return fn

    return wrap


def get_parser(name: str, version: str) -> Parser:
    try:
        return _PARSERS[(name, version)]
    except KeyError:
        known = ", ".join(f"{n}@{v}" for n, v in sorted(_PARSERS)) or "none"
        raise ParseError(f"no parser {name}@{version}; registered: {known}") from None


def registered_parsers() -> list[str]:
    return sorted(f"{n}@{v}" for n, v in _PARSERS)


@register_parser("json-lines", "1.0.0")
def _json_lines(raw: bytes, meta: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for lineno, line in enumerate(raw.decode("utf-8", "replace").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ParseError(f"line {lineno}: {exc}") from exc
        if not isinstance(value, dict):
            raise ParseError(f"line {lineno}: expected an object, got {type(value).__name__}")
        rows.append(value)
    return rows


class _ListingHTMLParser(HTMLParser):
    """Extracts `div.listing` blocks and their `span.<field>` children."""

    FIELDS = {"name", "age", "city", "state", "phone", "relatives"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict[str, Any]] = []
        self._current: dict[str, Any] | None = None
        self._field: str | None = None

    @staticmethod
    def _classes(attrs: list[tuple[str, str | None]]) -> set[str]:
        for key, value in attrs:
            if key == "class" and value:
                return set(value.split())
        return set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        classes = self._classes(attrs)
        if tag == "div" and "listing" in classes:
            attr = dict(attrs)
            self._current = {"listing_id": attr.get("data-id"), "listing_url": attr.get("data-url")}
        elif tag == "span" and self._current is not None:
            match = classes & self.FIELDS
            self._field = next(iter(match)) if match else None

    def handle_endtag(self, tag: str) -> None:
        if tag == "span":
            self._field = None
        elif tag == "div" and self._current is not None and self._field is None:
            if any(k not in ("listing_id", "listing_url") for k in self._current):
                self.rows.append(self._current)
            self._current = None

    def handle_data(self, data: str) -> None:
        if self._current is not None and self._field:
            text = data.strip()
            if text:
                self._current[self._field] = (self._current.get(self._field, "") + " " + text).strip()


@register_parser("people-search-listing", "3.2.0")
def _people_search_listing(raw: bytes, meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse a people-search result page into listing rows.

    Version 3.2.0 splits `relatives` on commas; 3.1.0 left it as free text.
    Bumping the version rather than editing in place is what makes the
    landing-zone backfill in A8 meaningful.
    """
    parser = _ListingHTMLParser()
    try:
        parser.feed(raw.decode("utf-8", "replace"))
        parser.close()
    except Exception as exc:  # HTMLParser raises bare exceptions on bad markup
        raise ParseError(f"malformed listing HTML: {exc}") from exc
    if not parser.rows:
        raise ParseError("no div.listing blocks found")
    for row in parser.rows:
        row["broker"] = meta.get("broker") or meta.get("system") or "unknown"
        row["source_url"] = meta.get("url") or row.get("listing_url")
        if "relatives" in row:
            row["relatives"] = [r.strip() for r in row["relatives"].split(",") if r.strip()]
        if "age" in row:
            try:
                row["age"] = int(str(row["age"]).strip())
            except ValueError:
                raise ParseError(f"non-numeric age {row['age']!r}") from None
    return parser.rows


# --------------------------------------------------------- CSV registries

def _decode_csv(raw: bytes) -> str:
    """Decode a CSV payload, tolerating a BOM and stray bytes."""
    return raw.decode("utf-8-sig", "replace")


def _rows_from_csv(raw: bytes) -> tuple[list[str], list[dict[str, str]]]:
    import csv
    import io

    text = _decode_csv(raw)
    if not text.strip():
        raise ParseError("empty CSV payload")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ParseError("CSV has no header row")
    return list(reader.fieldnames), list(reader)


@register_parser("csv-rows", "1.0.0")
def _csv_rows(raw: bytes, meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Generic CSV → one row per line, headers used verbatim as keys."""
    _headers, rows = _rows_from_csv(raw)
    return [
        {**{k: (v.strip() if isinstance(v, str) else v) for k, v in row.items() if k},
         "_row_number": n}
        for n, row in enumerate(rows, start=2)  # line 1 is the header
    ]


def normalise_header(name: str) -> str:
    """`  Data Broker Name ` -> `data_broker_name`."""
    return re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower()).strip("_")


# Registry column names are not a stable published contract, so every canonical
# field accepts several plausible spellings and anything unrecognised is kept
# in `extra` rather than dropped. If a registry renames a column, the ingest
# should degrade to "that field is now in extra", never to silent data loss.
REGISTRY_ALIASES: dict[str, str] = {}


def _alias(canonical: str, *spellings: str) -> None:
    for spelling in spellings:
        REGISTRY_ALIASES[normalise_header(spelling)] = canonical


_alias("broker_name", "data broker name", "broker name", "name", "business name",
       "company name", "registered business name", "legal name", "data broker")
_alias("alternate_names", "alternate names", "dba", "doing business as", "other names",
       "alternative names", "also known as")
_alias("registration_id", "registration number", "registration id", "broker number",
       "data broker registration number", "filing number", "id")
_alias("registry_year", "year", "registration year", "reporting year")
_alias("website_url", "website", "website url", "url", "web address", "business website")
_alias("privacy_policy_url", "privacy policy", "privacy policy url", "privacy policy link")
_alias("opt_out_url", "opt out url", "opt-out url", "opt out", "deletion url",
       "consumer request url", "do not sell url", "privacy rights url",
       "instructions url", "how to opt out", "deletion instructions")
_alias("email", "email", "email address", "contact email")
_alias("phone", "phone", "phone number", "telephone", "contact phone")
_alias("street_address", "address", "street address", "physical address",
       "mailing address", "address line 1")
_alias("city", "city")
_alias("state", "state", "state or province")
_alias("postal_code", "zip", "zip code", "postal code")
_alias("collects_minors_data", "minors", "data of minors", "collects minors data",
       "personal information of minors")
_alias("collects_precise_geolocation", "precise geolocation", "geolocation",
       "collects precise geolocation")
_alias("collects_reproductive_health_data", "reproductive health care data",
       "reproductive health", "reproductive healthcare data")
_alias("notes", "notes", "additional information", "comments")

_BOOLISH = {"yes": True, "y": True, "true": True, "1": True,
            "no": False, "n": False, "false": False, "0": False}
_FLAG_FIELDS = {
    "collects_minors_data",
    "collects_precise_geolocation",
    "collects_reproductive_health_data",
}


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")


@register_parser("ca-data-broker-registry", "1.0.0")
def _ca_data_broker_registry(raw: bytes, meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse a state data-broker registry CSV into canonical broker records.

    Written against the California registry export but deliberately not bound
    to it: the header map is alias-driven, so the Vermont export or a later
    California column rename is a mapping change, not a rewrite.

    `meta['registry']` names the source registry (default 'ca'); it becomes
    part of the dedupe key so two registries can share one table.
    """
    headers, rows = _rows_from_csv(raw)
    mapping = {header: REGISTRY_ALIASES.get(normalise_header(header)) for header in headers}

    if "broker_name" not in mapping.values():
        # The one failure worth killing the whole ingest for: without a name
        # column there is nothing to key on, and guessing would be worse.
        raise ParseError(
            "no recognisable broker-name column. Headers were: "
            + ", ".join(repr(h) for h in headers)
            + ". Add the new spelling to REGISTRY_ALIASES."
        )

    registry = str(meta.get("registry") or "ca").lower()
    year = str(meta.get("registry_year") or "").strip()

    out: list[dict[str, Any]] = []
    for line_number, raw_row in enumerate(rows, start=2):
        record: dict[str, Any] = {"registry": registry, "_row_number": line_number}
        extra: dict[str, Any] = {}

        for header, value in raw_row.items():
            if header is None:
                continue
            text = value.strip() if isinstance(value, str) else value
            if text in (None, ""):
                continue
            canonical = mapping.get(header)
            if canonical is None:
                extra[normalise_header(header)] = text
            elif canonical in _FLAG_FIELDS:
                record[canonical] = _BOOLISH.get(str(text).strip().lower(), None)
                if record[canonical] is None:
                    del record[canonical]
                    extra[normalise_header(header)] = text
            else:
                record[canonical] = text

        # A nameless row is one bad row, not a broken file: emit it and let the
        # destination contract reject it, so it is dead-lettered individually
        # with its line number instead of taking the whole registry down.
        name = record.get("broker_name")

        if year and "registry_year" not in record:
            record["registry_year"] = year
        # Prefer the registry's own identifier; fall back to a slug of the name
        # so the key is stable across refreshes either way.
        record["broker_key"] = str(
            record.get("registration_id") or (_slug(str(name)) if name else f"row-{line_number}")
        )
        if extra:
            record["extra"] = extra
        out.append(record)

    if not out:
        raise ParseError("registry CSV had a header but no rows")
    return out
