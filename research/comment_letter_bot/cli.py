"""Command line entry point and the run orchestration."""

import argparse
import datetime
import sys

from . import (census, config, edgar, insiders, letters as letters_mod, llm,
               prices, report, scoring)
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
            with_prices=True, with_insiders=True, as_of=None):
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

    # The event study runs from the dissemination date, which is the first
    # moment the market could price the letter at all.
    events = {}
    if series is not None:
        for analysis in analyses:
            event = prices.event_return(series, benchmark,
                                        analysis.filing.effective_public_date)
            if event:
                events[analysis.filing.accession] = event

    threads, insider_signals = [], {}
    if with_insiders:
        threads, insider_signals = _read_private_windows(
            fetcher, company, analyses, series, benchmark)

    verdict = scoring.evaluate(analyses, price=price_snapshot, events=events,
                               as_of=as_of, insider_signals=insider_signals)

    # -- assemble ----------------------------------------------------------
    letter_rows = []
    for contribution in verdict.contributions:
        analysis = contribution.analysis
        letter_rows.append({
            "form": analysis.filing.form,
            "filed": analysis.filing.filing_date.isoformat(),
            "public": (analysis.filing.public_date.isoformat()
                       if analysis.filing.public_date else None),
            "private_window_days": analysis.filing.private_window_days,
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
        "private_windows": threads,
        "price": price_snapshot,
        "price_error": price_error,
        "verdict": verdict.as_dict(),
    }
    return result, analyses, company


def _read_private_windows(fetcher, company, analyses, series, benchmark):
    """Read the issuer's feed across each review thread's private window.

    Letters released on the same day are one thread - EDGAR disseminates a
    whole review at once - so the window is a property of the thread, not of
    each letter. Reading it once per thread instead of once per letter keeps
    the request count down and is the correct unit anyway.
    """
    threads, signals = [], {}
    grouped = {}
    # Each window costs one request per Form 4 inside it. Scanning the most
    # recent few threads is where the information is; a review from 2019 is
    # not going to change a position taken today.
    max_windows = 4
    for analysis in analyses:
        filing = analysis.filing
        if not filing.was_private or not filing.public_date:
            continue
        grouped.setdefault(filing.public_date, []).append(analysis)

    for public_date in sorted(grouped, reverse=True)[:max_windows]:
        group = grouped[public_date]
        start = min(a.filing.filing_date for a in group)
        if (public_date - start).days < 3:
            continue                    # no meaningful window to look at
        activity = insiders.fetch_window_activity(
            fetcher, company, start, public_date, letter=group[0])
        if activity is None:
            continue

        # Score the window against the most substantive letter it covers.
        worst = min(group, key=lambda a: a.score)
        points, notes = activity.signal(worst.score)
        if points:
            signals[worst.filing.accession] = (points, notes)
        elif notes:
            signals[worst.filing.accession] = (0.0, notes)

        drift = (prices.window_return(series, benchmark, start, public_date)
                 if series is not None else None)
        threads.append({
            "letters_written_from": start.isoformat(),
            "public_on": public_date.isoformat(),
            "days": (public_date - start).days,
            "letters": [{"form": a.filing.form,
                         "dated": a.filing.filing_date.isoformat(),
                         "score": a.score} for a in group],
            "worst_letter_score": worst.score,
            "insider_points": points,
            "notes": notes,
            "price_drift": drift,
            "trades": [{"owner": t.owner, "role": t.role_text,
                        "date": t.date.isoformat(), "code": t.code,
                        "action": t.label, "shares": t.shares,
                        "price": t.price, "value": t.value,
                        "planned_10b5_1": t.planned,
                        "url": t.filing.index_url}
                       for t in sorted(activity.trades, key=lambda t: t.date)
                       if t.open_market],
            "other_filings": [{"form": f.form, "filed": f.filing_date.isoformat(),
                               "url": f.index_url}
                              for f in activity.other_filings],
        })
    return threads, signals


# ------------------------------------------------------------------- main --

def run_screen(args):
    """Market-wide screens built from a comment-letter census."""
    fetcher = Fetcher(use_cache=not args.no_cache)
    today = datetime.date.today()
    if args.screen_years:
        start = datetime.date(today.year - args.screen_years, 1, 1)
    else:
        start = datetime.date(args.screen_from, 1, 1)

    def progress(q_start, q_end, total):
        print("  scanning %s..%s  (%d documents)" % (q_start, q_end, total),
              file=sys.stderr)

    print("Building comment-letter census from %s to %s - first run fetches a "
          "few hundred pages, later runs read the cache." % (start, today),
          file=sys.stderr)
    registrants = census.build(fetcher, start, today, progress=progress)
    print("  %d registrants, %d letters.\n"
          % (len(registrants), sum(r.count for r in registrants.values())),
          file=sys.stderr)

    universe, universe_label = None, "every filer in the census"
    if args.watchlist:
        universe, universe_label = _load_watchlist(fetcher, args.watchlist)
    elif args.screen == "overdue":
        universe = set(census.ticker_universe(fetcher))
        universe_label = "currently listed filers"

    result = {
        "screen": args.screen,
        "census": {"from": start.isoformat(), "to": today.isoformat(),
                   "registrants": len(registrants),
                   "letters": sum(r.count for r in registrants.values())},
        "universe": universe_label,
        "rows": [],
    }

    if args.screen == "active":
        pool = registrants
        if args.listed_only or args.watchlist:
            allowed = universe if universe is not None else set(
                census.ticker_universe(fetcher))
            pool = {cik: r for cik, r in registrants.items() if cik in allowed}
            result["universe"] = (universe_label if args.watchlist
                                  else "currently listed filers")
        current = census.ticker_universe(fetcher)
        for registrant in census.most_active(pool, limit=args.screen_limit):
            name, ticker = current.get(registrant.cik,
                                       (registrant.name, registrant.ticker))
            result["rows"].append({
                "cik": registrant.cik, "name": name or registrant.name,
                "ticker": ticker or registrant.ticker,
                "letters": registrant.count,
                "threads": registrant.threads(),
                "longest_thread_rounds": registrant.rounds_in_longest_thread(),
                "first": registrant.first.isoformat(),
                "last": registrant.last.isoformat(),
            })
    else:
        census_days = (today - start).days
        rows = []

        # Names with no letter anywhere in the census are the most overdue of
        # all - their gap is at least the whole census window. They are only
        # folded in on request, because in a market-wide run there are
        # thousands of them and nothing in this data breaks the tie.
        if universe is not None:
            silent = census.never_in_window(registrants, universe)
            result["never_in_window"] = len(silent)
            result["never_included"] = bool(args.include_never)
            if args.include_never:
                names = census.ticker_universe(fetcher)
                check_ages = len(silent) <= census.AGE_CHECK_LIMIT
                for cik in silent:
                    name, ticker = names.get(cik, ("CIK %d" % cik, ""))
                    since = (census.first_filing_date(fetcher, cik)
                             if check_ages else None)
                    new = bool(since and since > start)
                    rows.append({"cik": cik, "name": name, "ticker": ticker,
                                 "letters": 0, "last": None,
                                 "days_since": (today - since).days if new
                                 else census_days,
                                 "years_since": round(
                                     ((today - since).days if new
                                      else census_days) / 365.25, 1),
                                 "censored": not new,
                                 "registrant_since": since.isoformat()
                                 if since else None,
                                 "new_registrant": new})

        # The census carries the company name as it read on the letter, which
        # for an old letter can be a name the company no longer uses.
        current = census.ticker_universe(fetcher) if universe is not None else {}
        for registrant, days in census.longest_without(
                registrants, universe=universe, as_of=today, limit=None):
            name, ticker = current.get(registrant.cik,
                                       (registrant.name, registrant.ticker))
            rows.append({
                "cik": registrant.cik, "name": name or registrant.name,
                "ticker": ticker or registrant.ticker,
                "letters": registrant.count,
                "last": registrant.last.isoformat(), "days_since": days,
                "years_since": round(days / 365.25, 1),
                "censored": census.is_censored(registrant, start),
            })

        rows.sort(key=lambda row: (row["days_since"], row["name"]), reverse=True)
        result["rows"] = rows[:args.screen_limit]
        result["census_years"] = round(census_days / 365.25, 1)

    print(report.render_json(result) if args.json
          else report.render_screen(result))
    return 0


def _load_watchlist(fetcher, path):
    """Read a file of tickers or CIKs, one per line, into a set of CIKs."""
    with open(path, encoding="utf-8") as handle:
        entries = [line.strip() for line in handle
                   if line.strip() and not line.startswith("#")]
    universe = set()
    for entry in entries:
        try:
            universe.add(edgar.resolve_company(fetcher, entry).cik)
        except edgar.NotFound:
            print("  watchlist: skipping unresolved %r" % entry, file=sys.stderr)
    return universe, "%d names from %s" % (len(universe), path)


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
    parser.add_argument("--no-insiders", action="store_true",
                        help="skip the private-window insider and institutional "
                             "filing scan")
    parser.add_argument("--no-cache", action="store_true",
                        help="bypass the on-disk response cache")
    parser.add_argument("--llm", action="store_true",
                        help="add narrative commentary via the Anthropic API")
    parser.add_argument("--json", action="store_true", help="emit JSON only")
    parser.add_argument("--full-text", metavar="ACCESSION",
                        help="print the extracted text of one filing and exit")

    screen = parser.add_argument_group("market-wide screens")
    screen.add_argument("--screen", choices=("active", "overdue"),
                        help="'active': most comment letters in the window. "
                             "'overdue': longest since the last one.")
    screen.add_argument("--screen-from", type=int, metavar="YEAR",
                        default=config.CENSUS_START_YEAR,
                        help="first year of the census (default: %(default)s). "
                             "A shallow census makes 'overdue' meaningless: "
                             "everything older than the window looks identical.")
    screen.add_argument("--screen-years", type=int, metavar="N",
                        help="census the last N years instead of from a fixed "
                             "year; a quick shallow run for --screen active")
    screen.add_argument("--screen-limit", type=int, default=25,
                        help="rows to print (default: %(default)s)")
    screen.add_argument("--watchlist", metavar="FILE",
                        help="restrict a screen to tickers or CIKs listed in "
                             "this file, one per line")
    screen.add_argument("--listed-only", action="store_true",
                        help="restrict --screen active to filers that currently "
                             "have a ticker, filtering out serial Reg A+ and "
                             "shelf filers you cannot trade")
    screen.add_argument("--include-never", action="store_true",
                        help="on --screen overdue, also list names with no "
                             "letter anywhere in the census window")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    interactive = not args.no_input and sys.stdin.isatty()

    if args.screen:
        return run_screen(args)

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
        with_prices=not args.no_prices, with_insiders=not args.no_insiders)

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
