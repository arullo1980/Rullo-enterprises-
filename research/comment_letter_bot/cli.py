"""Command line entry point and the run orchestration."""

import argparse
import datetime
import sys

from . import config, edgar, letters as letters_mod, llm, prices, report, scoring
from .http import Fetcher


# ----------------------------------------------------------------- prompts --

def _ask(prompt, default=None):
    suffix = " [%s]" % default if default else ""
    try:
        answer = input("%s%s: " % (prompt, suffix)).strip()
    except EOFError:
        return default or ""
    return answer or (default or "")


def _ask_yes_no(prompt, default=False):
    hint = "Y/n" if default else "y/N"
    answer = _ask("%s (%s)" % (prompt, hint)).lower()
    if not answer:
        return default
    return answer.startswith("y")


def _parse_date(text):
    text = (text or "").strip()
    for pattern in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%Y-%m", "%Y"):
        try:
            parsed = datetime.datetime.strptime(text, pattern).date()
        except ValueError:
            continue
        return parsed
    raise ValueError("could not read %r as a date (use YYYY-MM-DD)" % text)


def _ask_date(prompt):
    while True:
        raw = _ask(prompt)
        if not raw:
            return None
        try:
            parsed = _parse_date(raw)
        except ValueError as exc:
            print("  %s" % exc)
            continue
        if parsed > datetime.date.today():
            print("  That date is in the future.")
            continue
        return parsed


def _ask_float(prompt):
    while True:
        raw = _ask(prompt)
        if not raw:
            return None
        try:
            return float(raw.replace("$", "").replace(",", ""))
        except ValueError:
            print("  Enter a number, or leave blank.")


# --------------------------------------------------------------- the run ---

def analyse(fetcher, identifier, last_trade=None, side=None, entry_price=None,
            lookback_days=config.DEFAULT_LOOKBACK_DAYS, limit=None,
            with_prices=True, as_of=None):
    """Do the whole job and return the result dictionary the report renders."""
    as_of = as_of or datetime.date.today()
    company = edgar.resolve_company(fetcher, identifier)

    window_start = last_trade or (as_of - datetime.timedelta(days=lookback_days))
    filings = edgar.fetch_filings(fetcher, company, since=window_start)
    if limit:
        filings = filings[:limit]

    analyses = letters_mod.build(fetcher, filings, edgar.fetch_filing_text)

    # -- price context -----------------------------------------------------
    price_snapshot, price_error, series, benchmark = None, None, None, None
    if with_prices and company.ticker:
        history_start = min(window_start, as_of - datetime.timedelta(days=400)) \
            - datetime.timedelta(days=60)
        try:
            series = prices.fetch_series(fetcher, company.ticker, history_start, as_of)
            price_snapshot = prices.snapshot(series)
        except prices.PriceUnavailable as exc:
            price_error = "Price history unavailable for %s: %s" % (company.ticker, exc)
        if series is not None:
            try:
                benchmark = prices.fetch_series(
                    fetcher, config.BENCHMARK_SYMBOL, history_start, as_of)
            except prices.PriceUnavailable:
                benchmark = None
    elif with_prices:
        price_error = ("%s has no ticker in the SEC's mapping (private filer or "
                       "delisted); no price context available." % company.name)

    events = {}
    if series is not None:
        for analysis in analyses:
            event = prices.event_return(series, benchmark, analysis.filing.filing_date)
            if event:
                events[analysis.filing.accession] = event

    verdict = scoring.evaluate(analyses, price=price_snapshot, events=events,
                               as_of=as_of)

    # -- assemble ----------------------------------------------------------
    letter_rows = []
    for contribution in verdict.contributions:
        analysis = contribution.analysis
        letter_rows.append({
            "form": analysis.filing.form,
            "filed": analysis.filing.filing_date.isoformat(),
            "accession": analysis.filing.accession,
            "url": analysis.filing.index_url,
            "subject": analysis.letter.subject,
            "topics": analysis.headline_topics(5),
            "comment_count": len(analysis.letter.items),
            "closure": analysis.is_closure,
            "administrative": analysis.is_administrative,
            "amendment_language": analysis.amendment_required,
            "score": analysis.score,
            "weight": contribution.weight,
            "weighted": contribution.weighted,
            "summary": analysis.summary_lines(),
            "event": contribution.event,
        })

    trade = None
    if last_trade:
        trade = {"date": last_trade.isoformat(), "side": side or "position",
                 "price": entry_price, "since_pct": None, "pnl_pct": None}
        if series is not None:
            trade["since_pct"] = prices.pct_change(series, last_trade)
            if entry_price and series.last:
                move = (series.last / entry_price - 1.0) * 100.0
                trade["pnl_pct"] = -move if (side or "").lower() in (
                    "sell", "short") else move

    result = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "company": {"cik": company.cik, "name": company.name,
                    "ticker": company.ticker},
        "window": {"from": window_start.isoformat(), "to": as_of.isoformat(),
                   "days": (as_of - window_start).days,
                   "anchor": "last trade" if last_trade else "default lookback"},
        "last_trade": trade,
        "counts": {
            "staff": sum(1 for a in analyses if a.letter.is_staff_letter),
            "response": sum(1 for a in analyses if not a.letter.is_staff_letter),
            "administrative": sum(1 for a in analyses if a.is_administrative),
        },
        "letters": letter_rows,
        "price": price_snapshot,
        "price_error": price_error,
        "verdict": verdict.as_dict(),
    }
    return result, analyses, company


# ------------------------------------------------------------------- main --

def build_parser():
    parser = argparse.ArgumentParser(
        prog="comment-letter-bot",
        description="Scan SEC comment letters for a ticker, summarise what has "
                    "landed since your last trade, and read it against the "
                    "current price.")
    parser.add_argument("ticker", nargs="?", help="ticker symbol, CIK, or company name")
    parser.add_argument("--last-trade", metavar="YYYY-MM-DD",
                        help="date of your last trade in this name")
    parser.add_argument("--side", choices=("buy", "sell", "short", "hold"),
                        help="side of that trade")
    parser.add_argument("--entry-price", type=float, metavar="PRICE",
                        help="fill price of that trade")
    parser.add_argument("--lookback-days", type=int,
                        default=config.DEFAULT_LOOKBACK_DAYS,
                        help="window when there is no prior trade "
                             "(default: %(default)s)")
    parser.add_argument("--limit", type=int, help="cap the number of filings read")
    parser.add_argument("--no-input", action="store_true",
                        help="never prompt; use flags and defaults only")
    parser.add_argument("--no-prices", action="store_true",
                        help="skip price history entirely")
    parser.add_argument("--no-cache", action="store_true",
                        help="bypass the on-disk response cache")
    parser.add_argument("--llm", action="store_true",
                        help="add narrative commentary via the Anthropic API")
    parser.add_argument("--json", action="store_true", help="emit JSON only")
    parser.add_argument("--full-text", metavar="ACCESSION",
                        help="print the extracted text of one filing and exit")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    interactive = not args.no_input and sys.stdin.isatty()

    if config.user_agent_is_default():
        print("note: set SEC_USER_AGENT=\"Your Name your@email\" - EDGAR "
              "throttles unidentified traffic.\n", file=sys.stderr)

    ticker = args.ticker
    if not ticker:
        if not interactive:
            print("error: a ticker is required (or run without --no-input)",
                  file=sys.stderr)
            return 2
        print("SEC comment-letter bot")
        print("----------------------")
        ticker = _ask("Ticker symbol")
        if not ticker:
            print("No ticker given.", file=sys.stderr)
            return 2

    fetcher = Fetcher(use_cache=not args.no_cache)

    try:
        company = edgar.resolve_company(fetcher, ticker)
    except edgar.NotFound as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1

    if args.full_text:
        return _dump_full_text(fetcher, company, args.full_text)

    last_trade = _parse_date(args.last_trade) if args.last_trade else None
    side, entry_price = args.side, args.entry_price

    if interactive and not last_trade:
        print("\nMatched: %s (CIK %d, ticker %s)"
              % (company.name, company.cik, company.ticker or "n/a"))
        if _ask_yes_no("Have you traded this name before?"):
            last_trade = _ask_date("  Date of your last trade (YYYY-MM-DD)")
            if last_trade:
                side = (_ask("  Side (buy/sell/short/hold)", "buy") or "buy").lower()
                entry_price = _ask_float("  Fill price (optional)")
        if not last_trade:
            print("  No prior trade - defaulting to the last %d days."
                  % args.lookback_days)
        print()

    result, analyses, company = analyse(
        fetcher, ticker, last_trade=last_trade, side=side, entry_price=entry_price,
        lookback_days=args.lookback_days, limit=args.limit,
        with_prices=not args.no_prices)

    if args.llm:
        note = llm.enrich(result, analyses, company.name)
        if note:
            print("note: LLM commentary skipped - %s" % note, file=sys.stderr)

    print(report.render_json(result) if args.json else report.render_text(result))
    return 0


def _dump_full_text(fetcher, company, accession):
    filings = edgar.fetch_filings(fetcher, company, since=None)
    wanted = accession.replace("-", "")
    for filing in filings:
        if filing.accession_nodash == wanted:
            print(edgar.fetch_filing_text(fetcher, filing))
            return 0
    print("error: %s not found among %s's UPLOAD/CORRESP filings"
          % (accession, company.ticker or company.name), file=sys.stderr)
    return 1
