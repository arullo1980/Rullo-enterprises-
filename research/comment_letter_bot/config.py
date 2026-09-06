"""Runtime configuration for the SEC comment-letter bot.

Everything here is a plain constant or an environment lookup. There is no
config file to lose track of: flags on the command line beat environment
variables, which beat these defaults.
"""

import os
import pathlib

# ---------------------------------------------------------------- identity --

# The SEC requires a descriptive User-Agent with a contact address on every
# automated request. Anonymous or browser-spoofed traffic gets throttled and
# then blocked. Set SEC_USER_AGENT to "Your Name your@email" before real use.
CONTACT_EMAIL = "info@rulloenterprises.com"
DEFAULT_USER_AGENT = "Rullo Enterprises comment-letter-bot %s" % CONTACT_EMAIL


def user_agent():
    """SEC_USER_AGENT overrides; otherwise identify as Rullo Enterprises."""
    return os.environ.get("SEC_USER_AGENT", "").strip() or DEFAULT_USER_AGENT


# ------------------------------------------------------------------- hosts --

TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"
SUBMISSIONS_PAGE_URL = "https://data.sec.gov/submissions/{name}"
ARCHIVE_DIR_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}"
# browse-edgar resolves tickers the JSON map has dropped - delisted names,
# post-merger shells, anything no longer trading.
BROWSE_LOOKUP_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={identifier}"
    "&type=UPLOAD&dateb=&owner=include&count=1&output=atom"
)

# Yahoo's chart endpoint is unauthenticated and returns adjusted daily closes.
PRICE_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    "?period1={start}&period2={end}&interval=1d&events=div%2Csplit"
)
PRICE_USER_AGENT = "Mozilla/5.0 (compatible; comment-letter-bot)"

# Benchmark used to turn a raw post-letter move into a crude abnormal return.
BENCHMARK_SYMBOL = "SPY"

# --------------------------------------------------------------- behaviour --

# SEC asks for no more than 10 requests/second. We stay well under.
MIN_REQUEST_INTERVAL = 0.22
REQUEST_TIMEOUT = 30
MAX_RETRIES = 4

# Forms that carry the two sides of a filing review.
LETTER_FORMS = ("UPLOAD",)      # staff comment letter to the company
RESPONSE_FORMS = ("CORRESP",)   # company's written response
REVIEW_FORMS = LETTER_FORMS + RESPONSE_FORMS

# Forms worth watching inside the private window between a letter being
# written and EDGAR disseminating it. Form 4 is the insider transaction
# report; 144 is an affiliate's notice of intent to sell; the 13D/G
# amendments are institutional holders crossing a reporting threshold.
INSIDER_FORMS = ("4", "4/A")
AFFILIATE_SALE_FORMS = ("144", "144/A")
INSTITUTIONAL_FORMS = ("SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A",
                       "SCHEDULE 13D", "SCHEDULE 13D/A",
                       "SCHEDULE 13G", "SCHEDULE 13G/A")
WINDOW_FORMS = INSIDER_FORMS + AFFILIATE_SALE_FORMS + INSTITUTIONAL_FORMS

# Form 4 transaction codes. Open-market buys and sells are the only ones that
# say anything about conviction; the rest are grants, exercises, and tax
# withholding that happen on a schedule nobody chose this month.
OPEN_MARKET_CODES = {"P": "open-market purchase", "S": "open-market sale"}
DISCRETIONARY_CODES = {"P", "S", "F", "M", "G"}

# The census behind the screens reaches back to this year by default. The
# SEC began releasing comment letters in 2005, and its full-text index is
# reliable from about 2010; a census that starts later leaves the "overdue"
# screen unable to tell a five-year gap from a fifteen-year one.
CENSUS_START_YEAR = 2010

# When the user has never traded the name, look back this far instead.
DEFAULT_LOOKBACK_DAYS = 1095

# Half-life applied to a letter's score as it ages, in days. A comment letter
# from three years ago is a fact about history, not a live risk.
SCORE_HALF_LIFE_DAYS = 270

# Trading-day window used for the post-publication event study.
EVENT_WINDOW_DAYS = 10

# Optional LLM enrichment. Deterministic summaries are always produced; the
# model is only asked to add narrative colour on top of them.
LLM_MODEL = "claude-opus-5"


def cache_dir():
    override = os.environ.get("COMMENT_LETTER_BOT_CACHE")
    if override:
        return pathlib.Path(override).expanduser()
    base = os.environ.get("XDG_CACHE_HOME") or (pathlib.Path.home() / ".cache")
    return pathlib.Path(base) / "sec-comment-letter-bot"
