"""Versioned parser registry (A2).

Every parsed record carries the parser name and version that produced it, so a
fix can be backfilled over the landing zone rather than re-collected.
"""

from __future__ import annotations

import json
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
