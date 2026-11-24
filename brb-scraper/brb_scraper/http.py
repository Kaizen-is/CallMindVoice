"""A polite HTTP client: one place for timeouts, retries, pacing and robots.txt.

Every request in the scraper goes through `HttpClient.get`, so the rules for
how we treat someone else's server are written once:
  • obey robots.txt, except for URLs the site's owner explicitly allowed
    (`robots_allow` in sites.yaml, each with a note on who approved it);
  • never hit the same host more often than `min_delay_sec`;
  • retry only what is worth retrying (timeouts, 429, 5xx), waiting longer
    each time; a 404 is an answer, not a failure to retry.
"""
from __future__ import annotations

import logging
import os
import ssl
import threading
import time
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

import httpx

log = logging.getLogger(__name__)

RETRY_STATUS = {429, 500, 502, 503, 504}


class FetchError(RuntimeError):
    pass


def _tls_verify() -> ssl.SSLContext | bool:
    """Which certificates to trust.

    Default: certifi's bundle (httpx's default), which works for both sites.
    SCRAPER_TLS=system switches to the operating system's store, for networks
    whose firewall re-signs HTTPS with its own certificate.
    """
    if os.environ.get("SCRAPER_TLS", "").lower() == "system":
        import truststore

        truststore.inject_into_ssl()
        return ssl.create_default_context()
    return True


class HttpClient:
    def __init__(self, user_agent: str, timeout: float, retries: int, min_delay: float,
                 robots_allow: list[str] | None = None):
        self._client = httpx.Client(
            headers={"User-Agent": user_agent, "Accept-Language": "uz,ru;q=0.8,en;q=0.6"},
            timeout=timeout,
            follow_redirects=True,
            verify=_tls_verify(),
        )
        self._user_agent = user_agent
        self._retries = retries
        self._min_delay = min_delay
        self._robots: dict[str, RobotFileParser | None] = {}
        self._robots_allow = tuple(robots_allow or ())
        self._next_slot: dict[str, float] = {}
        self._lock = threading.Lock()

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HttpClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ── robots.txt ────────────────────────────────────────────────
    def allowed(self, url: str) -> bool:
        if self._robots_allow and url.startswith(self._robots_allow):
            return True
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        with self._lock:
            known = origin in self._robots
        if not known:
            parser: RobotFileParser | None = RobotFileParser()
            try:
                res = self._send(f"{origin}/robots.txt")
                if res.status_code == 200:
                    parser.parse(res.text.splitlines())
                else:
                    parser = None  # no robots.txt: everything allowed
            except FetchError:
                parser = None
            with self._lock:
                self._robots[origin] = parser
        robots = self._robots[origin]
        return robots is None or robots.can_fetch(self._user_agent, url)

    # ── requests ──────────────────────────────────────────────────
    def get(self, url: str, params: dict | None = None) -> httpx.Response:
        if not self.allowed(url):
            raise FetchError(f"blocked by robots.txt: {url}")
        return self._send(url, params)

    def _send(self, url: str, params: dict | None = None) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self._retries + 1):
            self._wait_turn(urlsplit(url).netloc)
            try:
                res = self._client.get(url, params=params)
                if res.status_code not in RETRY_STATUS:
                    return res
                last = FetchError(f"HTTP {res.status_code}")
            except (httpx.TimeoutException, httpx.TransportError) as err:
                last = err
            if attempt < self._retries:
                wait = 2**attempt  # 1 s, 2 s, 4 s …
                log.debug("retry %s in %ss (%s)", url, wait, last)
                time.sleep(wait)
        raise FetchError(f"{url}: {last}")

    def _wait_turn(self, host: str) -> None:
        """Reserve the next free time slot for this host, then sleep until it."""
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_slot.get(host, 0.0))
            self._next_slot[host] = slot + self._min_delay
        if slot > now:
            time.sleep(slot - now)
