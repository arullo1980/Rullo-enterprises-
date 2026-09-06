"""Daily price history, and the few statistics the verdict actually uses.

The point of the price side of this tool is not to predict anything from the
tape. It is to answer one question about each comment letter: when EDGAR
made it public, did the market care? A thesis built on a letter the market
already digested is a different trade from one built on a letter it ignored.
"""

import datetime
import math

from . import config
from .http import FetchError


class Series:
    def __init__(self, symbol, dates, closes, currency="USD"):
        self.symbol = symbol
        self.dates = dates          # list[datetime.date], ascending
        self.closes = closes        # list[float], same length
        self.currency = currency

    def __len__(self):
        return len(self.dates)

    @property
    def last(self):
        return self.closes[-1] if self.closes else None

    @property
    def last_date(self):
        return self.dates[-1] if self.dates else None

    def index_on_or_after(self, day):
        for index, date in enumerate(self.dates):
            if date >= day:
                return index
        return None

    def index_on_or_before(self, day):
        found = None
        for index, date in enumerate(self.dates):
            if date <= day:
                found = index
            else:
                break
        return found

    def close_on_or_before(self, day):
        index = self.index_on_or_before(day)
        return self.closes[index] if index is not None else None

    def sma(self, window):
        if len(self.closes) < window:
            return None
        return sum(self.closes[-window:]) / float(window)

    def annualised_vol(self, window=60):
        window = min(window, len(self.closes) - 1)
        if window < 10:
            return None
        returns = []
        for i in range(len(self.closes) - window, len(self.closes)):
            previous = self.closes[i - 1]
            if previous:
                returns.append(self.closes[i] / previous - 1.0)
        if len(returns) < 5:
            return None
        mean = sum(returns) / len(returns)
        variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
        return math.sqrt(variance) * math.sqrt(252) * 100.0

    def high_52w(self):
        cutoff = self.dates[-1] - datetime.timedelta(days=365)
        window = [c for d, c in zip(self.dates, self.closes) if d >= cutoff]
        return max(window) if window else None


def fetch_series(fetcher, symbol, start, end=None):
    """Daily adjusted closes for `symbol` between two dates."""
    end = end or datetime.date.today()
    start_epoch = int(datetime.datetime.combine(
        start, datetime.time()).replace(tzinfo=datetime.timezone.utc).timestamp())
    end_epoch = int(datetime.datetime.combine(
        end + datetime.timedelta(days=1), datetime.time()
    ).replace(tzinfo=datetime.timezone.utc).timestamp())

    url = config.PRICE_URL.format(symbol=symbol, start=max(start_epoch, 0),
                                  end=end_epoch)
    try:
        payload = fetcher.get_json(url, max_age=3600,
                                   user_agent=config.PRICE_USER_AGENT)
    except FetchError as exc:
        reason = "HTTP 404 - no such symbol on the price feed (delisted or " \
                 "renamed)" if "404" in str(exc) else str(exc)
        raise PriceUnavailable(reason) from exc

    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        raise PriceUnavailable(str(chart["error"]))
    results = chart.get("result") or []
    if not results:
        raise PriceUnavailable("no price data returned for %s" % symbol)

    result = results[0]
    stamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    adjclose = ((result.get("indicators") or {}).get("adjclose") or [{}])
    prices = (adjclose[0].get("adjclose") if adjclose and adjclose[0] else None) \
        or quote.get("close") or []

    dates, closes = [], []
    for stamp, price in zip(stamps, prices):
        if price is None:
            continue
        dates.append(datetime.datetime.fromtimestamp(
            stamp, tz=datetime.timezone.utc).date())
        closes.append(float(price))
    if not dates:
        raise PriceUnavailable("empty price series for %s" % symbol)

    currency = (result.get("meta") or {}).get("currency") or "USD"
    return Series(symbol, dates, closes, currency)


class PriceUnavailable(RuntimeError):
    """Price history could not be retrieved; the run continues without it."""


def pct_change(series, since):
    """Percentage move from the close on or before `since` to the latest."""
    start = series.close_on_or_before(since)
    if not start or not series.last:
        return None
    return (series.last / start - 1.0) * 100.0


def event_return(series, benchmark, event_date, window=config.EVENT_WINDOW_DAYS):
    """Return around a letter's publication, net of the benchmark.

    Measured from the close *before* the filing date to `window` trading days
    after it. Returns None when the window runs past the data we have - a
    letter published last week has no ten-day window yet, and pretending
    otherwise is how backtests lie.
    """
    index = series.index_on_or_after(event_date)
    if index is None or index == 0:
        return None
    end = index + window
    if end >= len(series):
        return None

    raw = (series.closes[end] / series.closes[index - 1] - 1.0) * 100.0
    if benchmark is None:
        return {"raw": raw, "abnormal": None, "benchmark": None,
                "window": window, "complete": True}

    b_index = benchmark.index_on_or_after(event_date)
    if b_index is None or b_index == 0 or b_index + window >= len(benchmark):
        return {"raw": raw, "abnormal": None, "benchmark": None,
                "window": window, "complete": True}

    market = (benchmark.closes[b_index + window] /
              benchmark.closes[b_index - 1] - 1.0) * 100.0
    return {"raw": raw, "abnormal": raw - market, "benchmark": market,
            "window": window, "complete": True}


def window_return(series, benchmark, start, end):
    """Return between two calendar dates, net of the benchmark.

    Used for the private window - what the stock did between a letter being
    written and EDGAR making it public. Unlike the event study this is not a
    reaction to anything the market could see, which is exactly why it is
    reported separately and never treated as one.
    """
    if not start or not end or end <= start:
        return None
    first = series.close_on_or_before(start)
    last = series.close_on_or_before(end)
    if not first or not last:
        return None
    raw = (last / first - 1.0) * 100.0

    abnormal = None
    if benchmark is not None:
        b_first = benchmark.close_on_or_before(start)
        b_last = benchmark.close_on_or_before(end)
        if b_first and b_last:
            abnormal = raw - (b_last / b_first - 1.0) * 100.0
    return {"raw": raw, "abnormal": abnormal,
            "days": (end - start).days}


def snapshot(series):
    """The handful of price facts the report prints."""
    sma50 = series.sma(50)
    sma200 = series.sma(200)
    high = series.high_52w()
    last = series.last
    return {
        "symbol": series.symbol,
        "currency": series.currency,
        "last": last,
        "as_of": series.last_date.isoformat() if series.last_date else None,
        "sma50": sma50,
        "sma200": sma200,
        "above_sma50": (last > sma50) if (last and sma50) else None,
        "above_sma200": (last > sma200) if (last and sma200) else None,
        "vol_60d_annualised": series.annualised_vol(60),
        "high_52w": high,
        "drawdown_from_52w_high": ((last / high - 1.0) * 100.0)
        if (last and high) else None,
    }
