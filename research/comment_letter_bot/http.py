"""A small, polite HTTP fetcher: rate limited, retried, and disk cached.

Standard library only. EDGAR is a public good with published etiquette rules;
this module is the one place that talks to the network, so those rules are
enforced in exactly one spot.
"""

import gzip
import hashlib
import io
import time
import urllib.error
import urllib.request

from . import config


class FetchError(RuntimeError):
    """A request failed after every retry, or came back with a hard error."""


class Fetcher:
    def __init__(self, user_agent=None, cache_dir=None, use_cache=True,
                 min_interval=None, timeout=None, max_retries=None):
        self.user_agent = user_agent or config.user_agent()
        self.cache_dir = cache_dir or config.cache_dir()
        self.use_cache = use_cache
        self.min_interval = (
            config.MIN_REQUEST_INTERVAL if min_interval is None else min_interval
        )
        self.timeout = timeout or config.REQUEST_TIMEOUT
        self.max_retries = config.MAX_RETRIES if max_retries is None else max_retries
        self._last_request = 0.0
        self.request_count = 0
        self.cache_hits = 0

    # -- cache -------------------------------------------------------------

    def _cache_path(self, url):
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
        return self.cache_dir / digest[:2] / (digest + ".bin")

    def _read_cache(self, url, max_age):
        if not self.use_cache:
            return None
        path = self._cache_path(url)
        try:
            stat = path.stat()
        except OSError:
            return None
        if max_age is not None and (time.time() - stat.st_mtime) > max_age:
            return None
        try:
            return path.read_bytes()
        except OSError:
            return None

    def _write_cache(self, url, payload):
        if not self.use_cache:
            return
        path = self._cache_path(url)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(payload)
            tmp.replace(path)
        except OSError:
            pass  # a broken cache must never break a run

    # -- network -----------------------------------------------------------

    def _throttle(self):
        elapsed = time.monotonic() - self._last_request
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_request = time.monotonic()

    def get(self, url, max_age=86400, user_agent=None, accept=None):
        """Return the response body as bytes, from cache when it is fresh."""
        cached = self._read_cache(url, max_age)
        if cached is not None:
            self.cache_hits += 1
            return cached

        headers = {
            "User-Agent": user_agent or self.user_agent,
            "Accept-Encoding": "gzip, deflate",
            "Accept": accept or "*/*",
        }
        last_error = None
        for attempt in range(self.max_retries):
            self._throttle()
            request = urllib.request.Request(url, headers=headers)
            try:
                self.request_count += 1
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = response.read()
                    if response.headers.get("Content-Encoding") == "gzip":
                        payload = gzip.GzipFile(fileobj=io.BytesIO(payload)).read()
                self._write_cache(url, payload)
                return payload
            except urllib.error.HTTPError as exc:
                last_error = exc
                # 404 means the document is genuinely not there; retrying the
                # SEC over a missing exhibit only burns our rate budget.
                if exc.code in (400, 403, 404):
                    raise FetchError("%s -> HTTP %s" % (url, exc.code)) from exc
            except Exception as exc:  # noqa: BLE001 - network layer is broad
                last_error = exc
            time.sleep(2 ** attempt)
        raise FetchError("%s failed after %d attempts: %s"
                         % (url, self.max_retries, last_error))

    def get_text(self, url, max_age=86400, user_agent=None, accept=None):
        payload = self.get(url, max_age=max_age, user_agent=user_agent, accept=accept)
        return payload.decode("utf-8", errors="replace")

    def get_json(self, url, max_age=86400, user_agent=None):
        import json

        return json.loads(self.get_text(url, max_age=max_age, user_agent=user_agent,
                                        accept="application/json"))
