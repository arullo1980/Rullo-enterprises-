"""Who traded while the letter was written but not yet public.

A comment letter is dated, sent, and answered weeks or months before EDGAR
disseminates it. Inside that window the company knows what the staff is
challenging and the market does not. This module reads the issuer's own filing
feed across exactly that window and reports what the people who did know were
doing with their shares.

Nothing here alleges wrongdoing. Most Form 4 activity is scheduled: grants,
option exercises, tax withholding, and sales under a pre-arranged Rule 10b5-1
plan adopted long before any letter existed. Form 4 carries a flag for that
last category, and this module separates it out - a discretionary open-market
sale by three officers is a different fact from a 10b5-1 plan running on
autopilot, and conflating them would produce a signal out of noise.
"""

import datetime
import xml.etree.ElementTree as ElementTree

from . import config, edgar
from .http import FetchError

# Form 4 must be filed within two business days of the trade, so a trade made
# on the last day of the private window can surface after it. Search filings a
# little past the window, then filter on the transaction date itself.
FILING_LAG_GRACE_DAYS = 6


class Trade:
    """One transaction line off a Form 4."""

    def __init__(self, owner, roles, date, code, shares, price, disposed,
                 planned, derivative, filing):
        self.owner = owner
        self.roles = roles
        self.date = date
        self.code = code
        self.shares = shares
        self.price = price
        self.disposed = disposed
        self.planned = planned          # filed under a Rule 10b5-1 plan
        self.derivative = derivative
        self.filing = filing

    @property
    def value(self):
        if self.shares is None or self.price is None:
            return None
        return self.shares * self.price

    @property
    def open_market(self):
        return self.code in config.OPEN_MARKET_CODES and not self.derivative

    @property
    def discretionary(self):
        """An open-market trade the insider chose to make in this window."""
        return self.open_market and not self.planned

    @property
    def label(self):
        return config.OPEN_MARKET_CODES.get(self.code, "code %s" % self.code)

    @property
    def role_text(self):
        return ", ".join(self.roles) if self.roles else "insider"


def _text(node, path):
    found = node.find(path)
    return (found.text or "").strip() if found is not None and found.text else ""


def _number(node, path):
    raw = _text(node, path)
    try:
        return float(raw.replace(",", ""))
    except (AttributeError, ValueError):
        return None


def _flag(node, path):
    return _text(node, path) in ("1", "true", "TRUE", "Y", "y")


def parse_form4(xml_text, filing):
    """Turn one Form 4 document into Trade rows. Returns [] if unparseable."""
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError:
        return []

    owners, roles = [], []
    for owner in root.findall("reportingOwner"):
        name = _text(owner, "reportingOwnerId/rptOwnerName")
        if name:
            owners.append(name.title())
        relationship = owner.find("reportingOwnerRelationship")
        if relationship is None:
            continue
        if _flag(relationship, "isDirector"):
            roles.append("director")
        if _flag(relationship, "isOfficer"):
            roles.append(_text(relationship, "officerTitle").lower() or "officer")
        if _flag(relationship, "isTenPercentOwner"):
            roles.append("10% owner")

    owner_name = "; ".join(owners) or "unnamed insider"
    roles = sorted(set(roles))
    planned = _flag(root, "aff10b5One")

    trades = []
    tables = (("nonDerivativeTable/nonDerivativeTransaction", False),
              ("derivativeTable/derivativeTransaction", True))
    for path, derivative in tables:
        for transaction in root.findall(path):
            date = _text(transaction, "transactionDate/value")
            try:
                date = datetime.date.fromisoformat(date)
            except ValueError:
                continue
            trades.append(Trade(
                owner=owner_name,
                roles=roles,
                date=date,
                code=_text(transaction, "transactionCoding/transactionCode"),
                shares=_number(transaction,
                               "transactionAmounts/transactionShares/value"),
                price=_number(
                    transaction,
                    "transactionAmounts/transactionPricePerShare/value"),
                disposed=_text(
                    transaction,
                    "transactionAmounts/transactionAcquiredDisposedCode/value") == "D",
                planned=planned,
                derivative=derivative,
                filing=filing,
            ))
    return trades


class WindowActivity:
    """Everything the issuer's feed shows inside one private window."""

    def __init__(self, start, end, trades, other_filings, letter=None):
        self.start = start
        self.end = end
        self.letter = letter
        self.trades = trades
        self.other_filings = other_filings

    @property
    def days(self):
        return (self.end - self.start).days

    def _bucket(self, code, discretionary_only):
        return [t for t in self.trades
                if t.code == code and t.open_market
                and (t.discretionary or not discretionary_only)]

    def buys(self, discretionary_only=True):
        return self._bucket("P", discretionary_only)

    def sells(self, discretionary_only=True):
        return self._bucket("S", discretionary_only)

    @property
    def planned_sales(self):
        return [t for t in self.trades
                if t.code == "S" and t.open_market and t.planned]

    @staticmethod
    def _value(trades):
        return sum(t.value or 0.0 for t in trades)

    @property
    def net_discretionary_value(self):
        return self._value(self.buys()) - self._value(self.sells())

    @property
    def distinct_sellers(self):
        return sorted({t.owner for t in self.sells()})

    @property
    def distinct_buyers(self):
        return sorted({t.owner for t in self.buys()})

    @property
    def is_empty(self):
        return not self.trades and not self.other_filings

    def filings_of(self, forms):
        return [f for f in self.other_filings if f.form in forms]

    # -- the part that reaches the verdict --------------------------------

    def signal(self, letter_score=0.0):
        """Points and notes, given how substantive the pending letter was.

        Trading inside the window of a routine non-GAAP comment says nothing.
        The signal is only read when the letter itself carried weight, which is
        what `letter_score` gates.
        """
        notes = []
        if letter_score > -10.0:
            if self.trades or self.other_filings:
                notes.append(
                    "Insider activity in this window is reported but not scored: "
                    "the pending letter was not substantive enough for it to mean "
                    "anything.")
            return 0.0, notes

        points = 0.0
        sells, buys = self.sells(), self.buys()
        sold, bought = self._value(sells), self._value(buys)

        if sells and sold > bought:
            sellers = len(self.distinct_sellers)
            points -= 8.0
            if sold >= 5_000_000 or sellers >= 4:
                points -= 6.0
            elif sold >= 1_000_000 or sellers >= 2:
                points -= 3.0
            notes.append(
                "%d discretionary open-market %s totalling $%s by %d insider(s) "
                "while the staff's letter was pending and not yet public."
                % (len(sells), "sale" if len(sells) == 1 else "sales",
                   format(int(sold), ","), sellers))

        if buys and bought > sold:
            points += 6.0 if bought >= 250_000 else 3.0
            notes.append(
                "Discretionary open-market buying of $%s by %d insider(s) inside "
                "the window - insiders adding while holding the letter is a "
                "contrary read." % (format(int(bought), ","),
                                    len(self.distinct_buyers)))

        if self.planned_sales and not sells:
            notes.append(
                "%d open-market sale(s) in the window, all flagged as Rule "
                "10b5-1 plan trades. Scheduled in advance, so not scored."
                % len(self.planned_sales))

        notices = self.filings_of(config.AFFILIATE_SALE_FORMS)
        if notices:
            points -= 3.0
            notes.append(
                "%d Form 144 notice(s) of proposed affiliate sales filed inside "
                "the window." % len(notices))

        institutional = self.filings_of(config.INSTITUTIONAL_FORMS)
        if institutional:
            notes.append(
                "%d Schedule 13D/G amendment(s) filed inside the window - a "
                "large holder crossed a reporting threshold. Direction is not "
                "scored here; open the filings to see which way."
                % len(institutional))

        return max(-25.0, min(12.0, points)), notes


def fetch_window_activity(fetcher, company, start, end, letter=None):
    """Read the issuer's feed across one private window."""
    if not start or not end or end <= start:
        return None

    filings = edgar.fetch_filings(
        fetcher, company, forms=config.WINDOW_FORMS, since=start,
        until=end + datetime.timedelta(days=FILING_LAG_GRACE_DAYS),
        include_history=False)

    trades, others = [], []
    for filing in filings:
        if filing.form not in config.INSIDER_FORMS:
            # 144s and 13D/G amendments are counted, not parsed: the useful
            # number in a 13G/A is a position delta that needs the prior
            # filing to compute, which is a bigger job than this window.
            if start <= filing.filing_date <= end:
                others.append(filing)
            continue
        url = filing.primary_document_url
        if not url:
            continue
        try:
            trades.extend(parse_form4(fetcher.get_text(url, max_age=None), filing))
        except FetchError:
            continue

    # Filter on the transaction date, not the filing date: Form 4 has a
    # two-business-day deadline and the report can land after the window shut.
    trades = [t for t in trades if start <= t.date <= end]
    return WindowActivity(start, end, trades, others, letter=letter)
