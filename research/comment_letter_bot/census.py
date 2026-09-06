"""A census of every comment letter EDGAR has released in a date range.

Built from EDGAR full-text search, which serves 100 hits per request and
filters by form server-side. The alternative - the quarterly full indexes -
is authoritative but costs about 50 MB per quarter, or four gigabytes for the
history this needs. Full-text search does the same job in a few hundred small
requests, and every response is cached to disk, so a rebuilt census is nearly
free after the first run.

Two things the census cannot tell you, both of which matter:

  * A filing review can close with no comment letter at all. No letter in the
    census does NOT mean no review - only that the staff had nothing to write
    down, or that everything it wrote is still inside its private window.
  * The dates here are the dates on the letters, not the dates EDGAR released
    them. That is the right basis for "how active has this company been",
    and the wrong one for "what did the market know when".
"""

import datetime
import re

from . import config
from .http import FetchError

SEARCH_URL = ("https://efts.sec.gov/LATEST/search-index"
              "?q=&forms={forms}&startdt={start}&enddt={end}&from={offset}")

PAGE_SIZE = 100
# Elasticsearch refuses deep paging past 10,000; a quarter has never come
# close in the modern era, but the guard keeps an old, busy quarter honest.
MAX_OFFSET = 9900

# "APPLE INC.  (AAPL)  (CIK 0000320193)"
_DISPLAY_RE = re.compile(r"^(?P<name>.*?)\s*(?:\((?P<tickers>[^()]*)\)\s*)?"
                         r"\(CIK (?P<cik>\d+)\)\s*$")


class Registrant:
    def __init__(self, cik, name, tickers):
        self.cik = int(cik)
        self.name = name
        self.tickers = tickers
        self.letters = {}               # accession -> date

    @property
    def ticker(self):
        return self.tickers[0] if self.tickers else ""

    @property
    def count(self):
        return len(self.letters)

    @property
    def dates(self):
        return sorted(self.letters.values())

    @property
    def first(self):
        return self.dates[0] if self.letters else None

    @property
    def last(self):
        return self.dates[-1] if self.letters else None

    def _clusters(self, gap_days=150, max_span_days=550):
        """Group letters into review threads.

        Two rules, and the second one matters: a gap longer than `gap_days`
        starts a new thread, and so does exceeding `max_span_days`. Without
        the span cap, a serial filer with a steady drip of letters chains into
        one imaginary review running for years - which is how a shelf filer
        ends up reported as a single 49-round review.
        """
        clusters, current = [], []
        for date in self.dates:
            if current and ((date - current[-1]).days > gap_days
                            or (date - current[0]).days > max_span_days):
                clusters.append(current)
                current = []
            current.append(date)
        if current:
            clusters.append(current)
        return clusters

    def threads(self, gap_days=150):
        return len(self._clusters(gap_days))

    def rounds_in_longest_thread(self, gap_days=150):
        clusters = self._clusters(gap_days)
        return max((len(c) for c in clusters), default=0)


def _parse_display(display_names, ciks):
    name, tickers, cik = "", [], None
    if display_names:
        match = _DISPLAY_RE.match(display_names[0].strip())
        if match:
            name = match.group("name").strip()
            cik = int(match.group("cik"))
            raw = match.group("tickers") or ""
            tickers = [t.strip().upper() for t in raw.split(",") if t.strip()]
        else:
            name = display_names[0].strip()
    if cik is None and ciks:
        cik = int(ciks[0])
    return cik, name, tickers


def _quarters(start, end):
    """Yield (start_date, end_date) for each quarter overlapping the range."""
    year, quarter = start.year, (start.month - 1) // 3
    while True:
        first = datetime.date(year, quarter * 3 + 1, 1)
        last_year, last_quarter = (year + 1, 0) if quarter == 3 else (year, quarter + 1)
        last = datetime.date(last_year, last_quarter * 3 + 1, 1) - \
            datetime.timedelta(days=1)
        if first > end:
            return
        yield max(first, start), min(last, end)
        year, quarter = last_year, last_quarter


def _fetch_page(fetcher, forms, start, end, offset, closed):
    url = SEARCH_URL.format(forms=forms, start=start.isoformat(),
                            end=end.isoformat(), offset=offset)
    # A closed quarter never changes, so cache it permanently.
    return fetcher.get_json(url, max_age=None if closed else 3600)


def _months(start, end):
    """Yield (first, last) for each calendar month overlapping the range."""
    first = datetime.date(start.year, start.month, 1)
    while first <= end:
        next_first = (datetime.date(first.year + 1, 1, 1) if first.month == 12
                      else datetime.date(first.year, first.month + 1, 1))
        yield max(first, start), min(next_first - datetime.timedelta(days=1), end)
        first = next_first


def build(fetcher, start, end=None, forms="UPLOAD", progress=None):
    """Return {cik: Registrant} for every letter filed in [start, end]."""
    end = end or datetime.date.today()
    today = datetime.date.today()
    registrants = {}

    spans = []
    for q_start, q_end in _quarters(start, end):
        spans.append((q_start, q_end))

    index = 0
    while index < len(spans):
        span_start, span_end = spans[index]
        index += 1
        closed = span_end < today - datetime.timedelta(days=7)
        offset, total = 0, None
        while True:
            try:
                payload = _fetch_page(fetcher, forms, span_start, span_end,
                                      offset, closed)
            except FetchError:
                break
            hits = (payload.get("hits") or {}).get("hits") or []
            if total is None:
                total = ((payload.get("hits") or {}).get("total") or {}).get("value", 0)
                # Full-text search cannot page past 10,000 documents. No
                # quarter since 2010 comes close, but if one ever does, split
                # it into months and scan those instead of silently truncating.
                if total > MAX_OFFSET and (span_end - span_start).days > 35:
                    spans[index:index] = list(_months(span_start, span_end))
                    break
                if progress:
                    progress(span_start, span_end, total)

            for hit in hits:
                source = hit.get("_source") or {}
                cik, name, tickers = _parse_display(
                    source.get("display_names"), source.get("ciks"))
                if cik is None:
                    continue
                accession = source.get("adsh") or hit.get("_id", "").split(":")[0]
                try:
                    filed = datetime.date.fromisoformat(source.get("file_date", ""))
                except ValueError:
                    continue
                entry = registrants.get(cik)
                if entry is None:
                    entry = registrants[cik] = Registrant(cik, name, tickers)
                elif not entry.tickers and tickers:
                    entry.tickers = tickers
                # Full-text search indexes documents, and one letter is filed
                # as a PDF plus a text extract. Dedupe on the accession.
                entry.letters[accession] = filed

            offset += PAGE_SIZE
            if len(hits) < PAGE_SIZE or offset > min(MAX_OFFSET, total or 0):
                break
    return registrants


# ------------------------------------------------------------------ screens --

def most_active(registrants, limit=25, min_letters=2):
    rows = [r for r in registrants.values() if r.count >= min_letters]
    rows.sort(key=lambda r: (r.count, r.rounds_in_longest_thread(), r.last or
                             datetime.date.min), reverse=True)
    return rows[:limit]


def longest_without(registrants, universe=None, as_of=None, limit=25):
    """Companies with a letter on record, ranked by how long ago it was.

    `universe` restricts the ranking to CIKs you care about - a watchlist, or
    the set of currently listed tickers. Without it, every filer that has ever
    drawn a letter in the census window is eligible, including private and
    delisted ones you cannot trade.
    """
    as_of = as_of or datetime.date.today()
    rows = []
    for registrant in registrants.values():
        if universe is not None and registrant.cik not in universe:
            continue
        if not registrant.last:
            continue
        rows.append((registrant, (as_of - registrant.last).days))
    rows.sort(key=lambda pair: pair[1], reverse=True)
    return rows if limit is None else rows[:limit]


# A company whose last letter sits at the very start of the census has an
# unknown true gap - anything earlier is outside what was scanned. Its rank is
# a floor, not a measurement, and the report says so.
CENSOR_MARGIN_DAYS = 45


def is_censored(registrant, census_start):
    if not census_start or not registrant.last:
        return False
    return (registrant.last - census_start).days <= CENSOR_MARGIN_DAYS


def never_in_window(registrants, universe):
    """CIKs in the universe with no letter anywhere in the census."""
    return sorted(set(universe) - set(registrants))


# Checking a registrant's age costs one request each, so it is only worth
# doing for a watchlist-sized set - never for a market-wide run.
AGE_CHECK_LIMIT = 60


def first_filing_date(fetcher, cik):
    """The earliest filing EDGAR holds for a CIK, or None.

    A company that reorganised into a new holding company, spun off, or
    redomiciled gets a brand-new CIK with no filing history and therefore no
    comment letters. Without this check it tops the overdue screen for the
    least interesting reason there is.
    """
    try:
        payload = fetcher.get_json(
            config.SUBMISSIONS_URL.format(cik10="%010d" % int(cik)),
            max_age=30 * 86400)
    except FetchError:
        return None

    candidates = []
    for extra in (payload.get("filings", {}).get("files") or []):
        candidates.append(extra.get("filingFrom", ""))
    candidates.extend(payload.get("filings", {}).get("recent", {})
                      .get("filingDate") or [])
    dates = []
    for value in candidates:
        try:
            dates.append(datetime.date.fromisoformat(value))
        except (TypeError, ValueError):
            continue
    return min(dates) if dates else None


def ticker_universe(fetcher):
    """{cik: (name, ticker)} for every currently listed filer."""
    mapping = fetcher.get_json(config.TICKER_MAP_URL, max_age=7 * 86400)
    rows = mapping.values() if isinstance(mapping, dict) else mapping
    universe = {}
    for row in rows:
        cik = int(row["cik_str"])
        universe.setdefault(cik, (row.get("title", ""),
                                  str(row.get("ticker", "")).upper()))
    return universe
