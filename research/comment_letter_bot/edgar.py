"""EDGAR access: ticker -> CIK, filing history, and letter text extraction.

Two form types matter here:

  UPLOAD   the SEC staff's comment letter to the company
  CORRESP  the company's written response back to the staff

EDGAR publishes both, but only about 20 business days after the staff
considers the review thread closed, so the *filing date* is the date the
market could first have seen the letter. Every date in this module is a
filing date for that reason.
"""

import datetime
import html
import json
import re
import urllib.parse

from . import config
from .http import FetchError


class NotFound(LookupError):
    """No company matched the identifier supplied."""


class Company:
    def __init__(self, cik, name, ticker, exchange=None):
        self.cik = int(cik)
        self.name = name
        self.ticker = ticker
        self.exchange = exchange

    @property
    def cik10(self):
        return "%010d" % self.cik

    def __repr__(self):
        return "Company(%s, %r)" % (self.ticker, self.name)


class Filing:
    def __init__(self, cik, form, filing_date, accession, primary_document,
                 report_date=None, items=None):
        self.cik = int(cik)
        self.form = form
        self.filing_date = filing_date          # datetime.date
        self.accession = accession
        self.primary_document = primary_document
        self.report_date = report_date
        self.items = items or ""
        self.text = None                        # filled in by fetch_filing_text

    @property
    def accession_nodash(self):
        return self.accession.replace("-", "")

    @property
    def directory_url(self):
        return "https://www.sec.gov/Archives/edgar/data/%d/%s" % (
            self.cik, self.accession_nodash)

    @property
    def submission_url(self):
        return "%s/%s.txt" % (self.directory_url, self.accession)

    @property
    def index_url(self):
        return "%s/%s-index.htm" % (self.directory_url, self.accession)

    @property
    def is_staff_letter(self):
        return self.form in config.LETTER_FORMS

    def __repr__(self):
        return "Filing(%s, %s)" % (self.form, self.filing_date)


# ------------------------------------------------------------- ticker -> CIK --

def resolve_company(fetcher, identifier):
    """Resolve a ticker symbol, a CIK, or a company-name fragment."""
    identifier = (identifier or "").strip()
    if not identifier:
        raise NotFound("no ticker supplied")

    mapping = fetcher.get_json(config.TICKER_MAP_URL, max_age=7 * 86400)
    rows = mapping.values() if isinstance(mapping, dict) else mapping

    wanted = identifier.upper().replace(".", "-")
    by_name = []
    for row in rows:
        ticker = str(row.get("ticker", "")).upper()
        title = str(row.get("title", ""))
        if ticker == wanted:
            return Company(row["cik_str"], title, ticker)
        if identifier.upper() in title.upper():
            by_name.append(Company(row["cik_str"], title, ticker))

    digits = re.sub(r"\D", "", identifier)
    if digits:
        for row in rows:
            if int(row["cik_str"]) == int(digits):
                return Company(row["cik_str"], row.get("title", ""),
                               str(row.get("ticker", "")).upper())

    if by_name:
        by_name.sort(key=lambda c: len(c.name))
        return by_name[0]

    resolved = _resolve_via_browse_edgar(fetcher, identifier)
    if resolved:
        return resolved
    raise NotFound(
        "no SEC registrant matches %r - try the full company name or the CIK "
        "number (the ticker map only covers currently listed filers)"
        % identifier)


_CIK_TAG_RE = re.compile(r"<cik>(\d+)</cik>", re.I)
_NAME_TAG_RE = re.compile(r"<conformed-name>([^<]+)</conformed-name>", re.I)


def _resolve_via_browse_edgar(fetcher, identifier):
    """Second pass for tickers the JSON map does not carry.

    company_tickers.json lists currently listed filers only, so a delisted or
    post-merger ticker misses there while EDGAR's own lookup still knows it.
    """
    try:
        xml = fetcher.get_text(
            config.BROWSE_LOOKUP_URL.format(
                identifier=urllib.parse.quote(identifier)), max_age=7 * 86400)
    except FetchError:
        return None
    cik = _CIK_TAG_RE.search(xml)
    name = _NAME_TAG_RE.search(xml)
    if not cik or not name:
        return None
    return Company(int(cik.group(1)), html.unescape(name.group(1)).strip(),
                   identifier.upper())


# ---------------------------------------------------------- filing history --

def _parse_date(value):
    try:
        return datetime.date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _rows_from_block(block):
    """Turn EDGAR's column-oriented filing block into row dicts."""
    forms = block.get("form") or []
    count = len(forms)
    keys = ("form", "filingDate", "accessionNumber", "primaryDocument",
            "reportDate", "items")
    columns = {key: block.get(key) or [] for key in keys}
    for index in range(count):
        yield {key: (columns[key][index] if index < len(columns[key]) else "")
               for key in keys}


def fetch_filings(fetcher, company, forms=config.REVIEW_FORMS, since=None,
                  include_history=True):
    """All filings of the given forms, newest first.

    EDGAR keeps only the most recent ~1000 filings in the main submissions
    document and pages the rest out; comment letters are often old enough to
    live in those extra pages, so we follow them unless told not to.
    """
    payload = fetcher.get_json(
        config.SUBMISSIONS_URL.format(cik10=company.cik10), max_age=6 * 3600)

    blocks = [payload.get("filings", {}).get("recent", {})]
    if include_history:
        for extra in payload.get("filings", {}).get("files", []) or []:
            name = extra.get("name")
            if not name:
                continue
            # Skip a history page whose whole range predates the cutoff.
            if since and _parse_date(extra.get("filingTo", "")) and \
                    _parse_date(extra["filingTo"]) < since:
                continue
            try:
                blocks.append(fetcher.get_json(
                    config.SUBMISSIONS_PAGE_URL.format(name=name),
                    max_age=30 * 86400))
            except FetchError:
                continue

    wanted = {form.upper() for form in forms} if forms else None
    filings = []
    for block in blocks:
        for row in _rows_from_block(block):
            form = (row["form"] or "").upper()
            if wanted and form not in wanted:
                continue
            filed = _parse_date(row["filingDate"])
            if filed is None or (since and filed < since):
                continue
            filings.append(Filing(
                cik=company.cik,
                form=form,
                filing_date=filed,
                accession=row["accessionNumber"],
                primary_document=row["primaryDocument"],
                report_date=_parse_date(row["reportDate"]),
                items=row["items"],
            ))
    filings.sort(key=lambda f: (f.filing_date, f.accession), reverse=True)
    return filings


# ------------------------------------------------------- document extraction --

_DOCUMENT_RE = re.compile(r"<DOCUMENT>(.*?)</DOCUMENT>", re.S | re.I)
_TAG_RE = re.compile(r"<(TYPE|FILENAME|DESCRIPTION)>([^\n<]*)", re.I)
_TEXT_RE = re.compile(r"<TEXT>(.*?)(?:</TEXT>|\Z)", re.S | re.I)
_BINARY_EXT = (".pdf", ".gif", ".jpg", ".jpeg", ".png", ".zip", ".xlsx")


def split_submission(raw):
    """Split a full EDGAR submission into (type, filename, body) triples."""
    documents = []
    for chunk in _DOCUMENT_RE.findall(raw):
        meta = {key.upper(): value.strip() for key, value in _TAG_RE.findall(chunk)}
        body = _TEXT_RE.search(chunk)
        documents.append((
            meta.get("TYPE", ""),
            meta.get("FILENAME", ""),
            body.group(1) if body else "",
        ))
    return documents


_SCRIPT_RE = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)
_BREAK_RE = re.compile(r"</(p|div|tr|h[1-6]|li)>|<br\s*/?>", re.I)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")
_BLANKS_RE = re.compile(r"[ \t\xa0]+")
_NEWLINES_RE = re.compile(r"\n{3,}")


def strip_html(raw):
    text = _SCRIPT_RE.sub(" ", raw)
    text = _BREAK_RE.sub("\n", text)
    text = _TAG_STRIP_RE.sub(" ", text)
    text = html.unescape(text)
    text = text.replace("\xa0", " ")
    text = _BLANKS_RE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    return _NEWLINES_RE.sub("\n\n", text).strip()


def _looks_binary(filename):
    return filename.lower().endswith(_BINARY_EXT)


def extract_text(raw):
    """Pull readable text out of a full submission.

    Staff comment letters are filed as scanned PDFs, but EDGAR attaches a
    machine-generated `TEXT-EXTRACT` document alongside them. Preferring that
    document is what lets this tool read UPLOAD filings with no PDF library.
    """
    documents = split_submission(raw)
    if not documents:
        return strip_html(raw)

    preferred = [d for d in documents if d[0].upper() == "TEXT-EXTRACT"]
    readable = [d for d in documents
                if not _looks_binary(d[1]) and d[0].upper() != "GRAPHIC"]
    for candidate in (preferred or readable or documents):
        body = candidate[2]
        if "<PDF>" in body[:400].upper():
            continue
        text = strip_html(body)
        if len(text) > 120:
            return text
    return ""


def fetch_filing_text(fetcher, filing):
    """Fetch and cache the readable text of a filing. Returns '' on failure."""
    if filing.text is not None:
        return filing.text
    try:
        raw = fetcher.get_text(filing.submission_url, max_age=None)
        filing.text = extract_text(raw)
    except FetchError:
        filing.text = ""
    return filing.text


def dump_json(company, filings):
    return json.dumps({
        "company": {"cik": company.cik, "name": company.name,
                    "ticker": company.ticker},
        "filings": [{"form": f.form, "filed": f.filing_date.isoformat(),
                     "accession": f.accession, "url": f.index_url}
                    for f in filings],
    }, indent=2)
