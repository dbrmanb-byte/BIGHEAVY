"""Mode A politeness controls (A5). These are the rules that keep collection lawful."""

from __future__ import annotations

import io
import urllib.error

import pytest

from sweeper.connectors import Record, build
from sweeper.errors import RecordError, SpecInvalid


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200) -> None:
        super().__init__(body)
        self.status = status
        self.headers = {"Content-Type": "text/html"}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def opener_for(pages: dict[str, bytes]):
    calls: list[str] = []

    def _open(request, timeout=None):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        calls.append(url)
        if url not in pages:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        return FakeResponse(pages[url])

    _open.calls = calls  # type: ignore[attr-defined]
    return _open


def connector(pages, **politeness):
    base = {
        "respect_robots": True,
        "crawl_delay_ms": 0,
        "user_agent": "TestSweeper/1.0",
        "host_allowlist": ["allowed.test"],
    }
    base.update(politeness)
    return build(
        "http-listing",
        {
            "targets": [{"id": "t1", "url": "https://allowed.test/p/1"}],
            "politeness": base,
            "_opener": opener_for(pages),
        },
    )


def test_host_not_on_the_allowlist_is_refused():
    conn = connector({}, host_allowlist=["other.test"])
    with pytest.raises(SpecInvalid, match="host_allowlist"):
        conn.read(Record(id="t1", meta={"url": "https://allowed.test/p/1"}))


def test_an_empty_allowlist_is_refused_rather_than_treated_as_allow_all():
    conn = connector({}, host_allowlist=[])
    with pytest.raises(SpecInvalid, match="requires action.politeness.host_allowlist"):
        conn.read(Record(id="t1", meta={"url": "https://allowed.test/p/1"}))


def test_robots_disallow_blocks_the_fetch():
    pages = {
        "https://allowed.test/robots.txt": b"User-agent: *\nDisallow: /p/",
        "https://allowed.test/p/1": b"<html>secret</html>",
    }
    conn = connector(pages)
    with pytest.raises(RecordError, match="robots.txt disallows"):
        conn.read(Record(id="t1", meta={"url": "https://allowed.test/p/1"}))


def test_robots_allow_permits_the_fetch():
    pages = {
        "https://allowed.test/robots.txt": b"User-agent: *\nAllow: /",
        "https://allowed.test/p/1": b"<html>ok</html>",
    }
    conn = connector(pages)
    record = conn.read(Record(id="t1", meta={"url": "https://allowed.test/p/1"}))
    assert record.raw == b"<html>ok</html>"


def test_robots_is_fetched_once_per_host():
    pages = {
        "https://allowed.test/robots.txt": b"User-agent: *\nAllow: /",
        "https://allowed.test/p/1": b"a",
        "https://allowed.test/p/2": b"b",
    }
    conn = connector(pages)
    conn.read(Record(id="t1", meta={"url": "https://allowed.test/p/1"}))
    conn.read(Record(id="t2", meta={"url": "https://allowed.test/p/2"}))
    assert conn._opener.calls.count("https://allowed.test/robots.txt") == 1


def test_unreachable_robots_does_not_become_permission_to_ignore_the_delay():
    pages = {"https://allowed.test/p/1": b"<html>ok</html>"}  # robots.txt 404s
    conn = connector(pages, crawl_delay_ms=10)
    record = conn.read(Record(id="t1", meta={"url": "https://allowed.test/p/1"}))
    assert record.raw == b"<html>ok</html>"
    assert conn.crawl_delay_s == 0.01


def test_robots_crawl_delay_overrides_a_smaller_configured_delay():
    pages = {
        "https://allowed.test/robots.txt": b"User-agent: *\nAllow: /\nCrawl-delay: 5",
        "https://allowed.test/p/1": b"ok",
    }
    conn = connector(pages, crawl_delay_ms=1)
    conn._robots.allows("https://allowed.test/p/1")  # populate the cache
    assert conn._robots.crawl_delay("https://allowed.test/p/1") == 5.0


def test_http_error_becomes_a_record_error():
    pages = {"https://allowed.test/robots.txt": b"User-agent: *\nAllow: /"}
    conn = connector(pages)
    with pytest.raises(RecordError, match="HTTP 404"):
        conn.read(Record(id="t1", meta={"url": "https://allowed.test/p/1"}))


def test_host_clock_serialises_requests_to_one_host():
    import time

    from sweeper.connectors.http_listing import _HostClock

    clock = _HostClock()
    started = time.monotonic()
    clock.wait("h", 0.05)
    clock.wait("h", 0.05)
    assert time.monotonic() - started >= 0.05
