"""HTTP source for mode A, with the politeness controls A5 requires.

Every request is gated on three things: the host is on the spec's allowlist,
robots.txt permits the path, and the crawl delay has elapsed. There is no way
to fetch through this connector without passing all three.
"""

from __future__ import annotations

import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from typing import Any

from ..errors import RecordError, SpecInvalid
from . import Batch, Capabilities, Connector, Record, register

DEFAULT_UA = "BigHeavySweeper/0.1 (+https://bigheavy.dev/bot)"


class RobotsCache:
    """One parsed robots.txt per host, fetched once."""

    def __init__(self, user_agent: str, opener: Any = None) -> None:
        self.user_agent = user_agent
        self._opener = opener or urllib.request.urlopen
        self._cache: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._lock = threading.Lock()

    def _load(self, origin: str) -> urllib.robotparser.RobotFileParser | None:
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(urllib.parse.urljoin(origin, "/robots.txt"))
        try:
            request = urllib.request.Request(
                parser.url, headers={"User-Agent": self.user_agent}
            )
            with self._opener(request, timeout=10) as response:
                parser.parse(response.read().decode("utf-8", "replace").splitlines())
        except (urllib.error.URLError, OSError, ValueError):
            # An unreachable robots.txt is not permission to crawl hard; callers
            # still hold the configured crawl delay. Treat as "no rules stated".
            parser.parse([])
        return parser

    def allows(self, url: str) -> bool:
        origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(url))
        with self._lock:
            if origin not in self._cache:
                self._cache[origin] = self._load(origin)
            parser = self._cache[origin]
        return True if parser is None else parser.can_fetch(self.user_agent, url)

    def crawl_delay(self, url: str) -> float | None:
        origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(url))
        with self._lock:
            parser = self._cache.get(origin)
        if parser is None:
            return None
        try:
            delay = parser.crawl_delay(self.user_agent)
        except AttributeError:  # pragma: no cover - very old stdlib
            return None
        return float(delay) if delay else None


class _HostClock:
    """Enforces a minimum interval between requests to the same host."""

    def __init__(self) -> None:
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, host: str, delay_s: float) -> None:
        if delay_s <= 0:
            return
        while True:
            with self._lock:
                now = time.monotonic()
                earliest = self._last.get(host, 0.0) + delay_s
                if now >= earliest:
                    self._last[host] = now
                    return
                sleep_for = earliest - now
            time.sleep(sleep_for)


@register("http-listing")
class HttpListingConnector(Connector):
    """Config: urls (list) or url_field on seeded items, base_url, timeout_s.

    Politeness settings come from the spec's `action.politeness` block and are
    passed in as `config['politeness']` by the collect pipeline.
    """

    def __init__(self, config: dict[str, Any] | None = None, auth: Any = None) -> None:
        super().__init__(config, auth)
        politeness = self.config.get("politeness") or {}
        self.user_agent = politeness.get("user_agent") or DEFAULT_UA
        self.respect_robots = politeness.get("respect_robots", True)
        self.crawl_delay_s = float(politeness.get("crawl_delay_ms", 1000)) / 1000.0
        self.host_allowlist = set(politeness.get("host_allowlist") or [])
        self.timeout_s = float(self.config.get("timeout_s", 20))
        self.targets: list[dict[str, Any]] = list(self.config.get("targets") or [])
        self._opener = self.config.get("_opener") or urllib.request.urlopen
        self._robots = RobotsCache(self.user_agent, self._opener)
        self._clock = _HostClock()

    def capabilities(self) -> Capabilities:
        return Capabilities(incremental=True)

    def _check_host(self, url: str) -> str:
        host = urllib.parse.urlsplit(url).netloc
        if not self.host_allowlist:
            raise SpecInvalid("http-listing requires action.politeness.host_allowlist (A5)")
        if host not in self.host_allowlist:
            raise SpecInvalid(f"host {host!r} is not on the spec's host_allowlist (A5)")
        return host

    def partitions(self, scope: dict[str, Any]) -> list[str]:
        field = scope.get("partition_by")
        if not field:
            return ["default"]
        return sorted({str(t.get(field, "default")) for t in self.targets}) or ["default"]

    def enumerate(
        self,
        partition: str,
        cursor: Any,
        batch_size: int,
        scope: dict[str, Any],
        watermark: Any = None,
    ) -> Batch:
        field = scope.get("partition_by")
        targets = (
            self.targets
            if not field
            else [t for t in self.targets if str(t.get(field, "default")) == partition]
        )
        offset = int(cursor or 0)
        window = targets[offset : offset + batch_size]
        records = [
            Record(
                id=str(t.get("id") or t["url"]),
                cursor=offset + i + 1,
                meta={k: v for k, v in t.items() if k != "id"},
            )
            for i, t in enumerate(window)
        ]
        nxt = offset + len(window)
        return Batch(records=records, next_cursor=nxt, exhausted=nxt >= len(targets))

    def read(self, record: Record) -> Record:
        url = record.meta.get("url")
        if not url:
            raise RecordError(f"record {record.id} has no url")
        host = self._check_host(url)
        if self.respect_robots and not self._robots.allows(url):
            raise RecordError(f"robots.txt disallows {url}")
        delay = max(self.crawl_delay_s, self._robots.crawl_delay(url) or 0.0)
        self._clock.wait(host, delay)
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
        try:
            with self._opener(request, timeout=self.timeout_s) as response:
                record.raw = response.read()
                record.meta["status"] = getattr(response, "status", 200)
                record.meta["content_type"] = response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            raise RecordError(f"HTTP {exc.code} for {url}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise RecordError(f"fetch failed for {url}: {exc}") from exc
        return record
