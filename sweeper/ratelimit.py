"""Token-bucket rate limiting, shared across worker threads (R1.2.4)."""

from __future__ import annotations

import threading
import time


class TokenBucket:
    """A thread-safe token bucket.

    One instance per source, shared by every worker touching that source, so
    the configured rate is a property of the source rather than of one thread.
    """

    def __init__(self, rate_per_second: float, capacity: float | None = None) -> None:
        if rate_per_second <= 0:
            raise ValueError("rate_per_second must be positive")
        self.rate = float(rate_per_second)
        self.capacity = float(capacity if capacity is not None else max(1.0, rate_per_second))
        self._tokens = self.capacity
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self, tokens: float = 1.0, timeout: float | None = None) -> bool:
        """Block until `tokens` are available. False if `timeout` elapses first."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(self.capacity, self._tokens + (now - self._updated) * self.rate)
                self._updated = now
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return True
                shortfall = tokens - self._tokens
                wait = shortfall / self.rate
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                wait = min(wait, remaining)
            time.sleep(wait)


class NullBucket:
    """Used when a spec sets no rate limit."""

    def acquire(self, tokens: float = 1.0, timeout: float | None = None) -> bool:
        return True


def bucket_for(rate_per_second: float | None) -> TokenBucket | NullBucket:
    return TokenBucket(rate_per_second) if rate_per_second else NullBucket()


def backoff_delays(attempts: int, base: float = 0.5, cap: float = 30.0) -> list[float]:
    """Exponential backoff with deterministic jitter slots (R1.2.4).

    Jitter is applied by the caller from a seeded Random so retries stay
    reproducible in tests.
    """
    return [min(cap, base * (2**i)) for i in range(attempts)]
