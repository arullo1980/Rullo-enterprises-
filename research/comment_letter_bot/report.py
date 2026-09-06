"""Rendering. Plain text for a terminal, JSON for anything downstream."""

import json
import textwrap

RULE = "=" * 78
THIN = "-" * 78

DISCLAIMER = (
    "SEC comment letters are a slow and sparse signal. EDGAR holds a review "
    "thread back and releases it in one batch once the review closes - often "
    "weeks, sometimes months, after the letters were written - so the date on "
    "a letter is not the date the market could see it. Everything above "
    "anchors its market arithmetic on the dissemination date and reports the "
    "private window separately. Research support for your own process, not "
    "investment advice and not an execution trigger."
)


def _wrap(text, indent="  ", width=78):
    return textwrap.fill(text, width=width, initial_indent=indent,
                         subsequent_indent=indent)


def _money(value, currency="USD"):
    if value is None:
        return "n/a"
    symbol = "$" if currency == "USD" else ""
    return "%s%s" % (symbol, format(value, ",.2f"))


# Summary lines that continue the previous bullet rather than starting one.
_CONTINUATIONS = ("answered:", "Tone:", "Response:")


def _count(value):
    return "n/a" if value is None else format(int(value), ",")


def _plural(count, noun):
    return noun if count == 1 else noun + "s"


def _bullet(text, indent="  "):
    if text.startswith(_CONTINUATIONS):
        return textwrap.fill(text, width=78, initial_indent=indent + "    ",
                             subsequent_indent=indent + "    ")
    return textwrap.fill(text, width=78, initial_indent=indent + "- ",
                         subsequent_indent=indent + "  ")


def _pct(value, places=1):
    return "n/a" if value is None else "%+.*f%%" % (places, value)


def render_text(result):
    company = result["company"]
    lines = [RULE,
             "  SEC COMMENT-LETTER READ - %s (%s)" % (company["name"],
                                                      company["ticker"] or "no ticker"),
             "  CIK %d | window %s to %s" % (company["cik"], result["window"]["from"],
                                             result["window"]["to"]),
             RULE, ""]

    # -- position ----------------------------------------------------------
    trade = result.get("last_trade")
    if trade and trade.get("date"):
        side = (trade.get("side") or "").upper()
        line = ("Last trade: %s on %s" % (side, trade["date"]) if side
                else "Last trade: %s" % trade["date"])
        if trade.get("price"):
            line += " at %s" % _money(trade["price"])
        lines.append(line)
        if trade.get("since_pct") is not None:
            lines.append("  Price since that trade: %s" % _pct(trade["since_pct"]))
        if trade.get("pnl_pct") is not None:
            lines.append("  Position P&L on that entry: %s" % _pct(trade["pnl_pct"]))
        lines.append("")
    else:
        lines.append("No prior trade recorded - reviewing the last %d days.\n"
                     % result["window"]["days"])

    # -- letters -----------------------------------------------------------
    letters = result["letters"]
    lines.append(THIN)
    lines.append("  1. FILING REVIEW ACTIVITY  (%d %s: %d staff, %d company %s)"
                 % (len(letters), _plural(len(letters), "filing"),
                    result["counts"]["staff"], result["counts"]["response"],
                    _plural(result["counts"]["response"], "response")))
    if result["counts"].get("administrative"):
        lines.append("  %d of them are administrative (acceleration, "
                     "withdrawal, or no-review notices)."
                     % result["counts"]["administrative"])
    lines.append(THIN)
    if not letters:
        lines.append(_wrap("No UPLOAD (staff comment letter) or CORRESP "
                           "(company response) filings in this window."))
    for letter in letters:
        lines.append("")
        label = "STAFF LETTER" if letter["form"] == "UPLOAD" else "COMPANY RESPONSE"
        dates = "dated %s" % letter["filed"]
        if letter.get("public") and letter.get("private_window_days"):
            dates += ", public %s (held %d days)" % (letter["public"],
                                                     letter["private_window_days"])
        lines.append("  [%s] %s  %s" % (dates, label, letter["accession"]))
        if letter["topics"]:
            lines.append("  Topics: %s" % ", ".join(letter["topics"]))
        lines.append("  Letter score: %+.0f  (aged weight %.2f -> %+.0f)"
                     % (letter["score"], letter["weight"], letter["weighted"]))
        for bullet in letter["summary"]:
            lines.append(_bullet(bullet))
        if letter.get("event"):
            event = letter["event"]
            lines.append("  Reaction over the %d sessions after it went public: "
                         "raw %s%s"
                         % (event["window"], _pct(event["raw"]),
                            "" if event.get("abnormal") is None
                            else ", vs benchmark %s" % _pct(event["abnormal"])))
        if letter.get("narrative"):
            lines.append(_wrap("LLM read: " + letter["narrative"], indent="  "))
        lines.append("  %s" % letter["url"])

    # -- private windows ---------------------------------------------------
    windows = result.get("private_windows") or []
    if windows:
        lines.append("")
        lines.append(THIN)
        lines.append("  2. PRIVATE WINDOW  (between the letter and its release)")
        lines.append(THIN)
        lines.append(_wrap(
            "EDGAR holds a review thread back and releases it in one batch once "
            "the review closes. In the window below the company knew what the "
            "staff was challenging and the market did not."))
        for window in windows:
            lines.append("")
            lines.append("  %s -> public %s   (%d days)"
                         % (window["letters_written_from"], window["public_on"],
                            window["days"]))
            drift = window.get("price_drift")
            if drift:
                lines.append("  Stock across the window: raw %s%s"
                             % (_pct(drift["raw"]),
                                "" if drift.get("abnormal") is None
                                else ", vs benchmark %s" % _pct(drift["abnormal"])))
            trades = window.get("trades") or []
            if trades:
                for trade in trades:
                    flag = "  [10b5-1 plan]" if trade["planned_10b5_1"] else ""
                    lines.append("    %s  %-22s %-18s %s sh @ %s = %s%s"
                                 % (trade["date"], trade["owner"][:22],
                                    trade["action"],
                                    _count(trade["shares"]),
                                    _money(trade["price"]),
                                    _money(trade["value"]), flag))
            else:
                lines.append("    No open-market insider transactions in the "
                             "window.")
            for filing in window.get("other_filings") or []:
                lines.append("    %s  %s filed inside the window  %s"
                             % (filing["filed"], filing["form"], filing["url"]))
            for note in window.get("notes") or []:
                lines.append(_bullet(note, indent="    "))

    # -- price -------------------------------------------------------------
    lines.append("")
    lines.append(THIN)
    lines.append("  3. PRICE CONTEXT")
    lines.append(THIN)
    price = result.get("price")
    if not price:
        lines.append(_wrap(result.get("price_error")
                           or "Price history unavailable; the read below rests "
                              "on the filings alone."))
    else:
        currency = price.get("currency", "USD")
        lines.append("  Last close      %s  (%s)" % (_money(price["last"], currency),
                                                     price["as_of"]))
        lines.append("  50d / 200d SMA  %s / %s"
                     % (_money(price["sma50"], currency),
                        _money(price["sma200"], currency)))
        lines.append("  52w high        %s   drawdown %s"
                     % (_money(price["high_52w"], currency),
                        _pct(price["drawdown_from_52w_high"])))
        lines.append("  60d vol (ann.)  %s"
                     % ("n/a" if price["vol_60d_annualised"] is None
                        else "%.1f%%" % price["vol_60d_annualised"]))

    # -- verdict -----------------------------------------------------------
    verdict = result["verdict"]
    lines.append("")
    lines.append(RULE)
    lines.append("  4. READ: %s   (confidence: %s)"
                 % (verdict["direction"], verdict["confidence"]))
    lines.append(RULE)
    if verdict["headline"]:
        lines.append(_wrap(verdict["headline"]))
    lines.append("")
    lines.append("  Composite %+.1f = %.2f x residual %+.1f  +  %.2f x trend %+.1f"
                 % (verdict["composite"], 0.80, verdict["residual"],
                    0.20, verdict["momentum"]))
    lines.append("    pressure from the letters          : %+.1f"
                 % verdict.get("letter_pressure", 0.0))
    if verdict.get("insider_pressure"):
        lines.append("    private-window insider activity    : %+.1f"
                     % verdict["insider_pressure"])
    lines.append("    fundamental pressure (combined)    : %+.1f"
                 % verdict["fundamental_pressure"])
    lines.append("    estimated already priced in        : %s"
                 % ("not measurable" if verdict["priced_in_points"] is None
                    else "%+.1f" % verdict["priced_in_points"]))
    lines.append("")
    for reason in verdict["reasons"]:
        lines.append(_bullet(reason))
    for flag in verdict["flags"]:
        lines.append(_bullet(flag, indent=" ").replace("- ", "! ", 1))
    if result.get("narrative"):
        lines.append("")
        lines.append(_wrap("LLM synthesis: " + result["narrative"]))

    lines.append("")
    lines.append(THIN)
    lines.append(_wrap(DISCLAIMER))
    lines.append(THIN)
    return "\n".join(lines)


SCREEN_CAVEAT = (
    "A filing review can close with no comment letter at all, and letters "
    "written recently are still inside their private window. So a long gap is "
    "evidence that a company has not drawn written comments - not proof it has "
    "not been reviewed. Sarbanes-Oxley section 408 obliges the staff to review "
    "every reporting company at least once every three years, which is what "
    "makes the top of the second screen worth reading."
)


def render_screen(result):
    census = result["census"]
    title = ("MOST ACTIVE - companies drawing the most SEC comment letters"
             if result["screen"] == "active"
             else "LONGEST WITHOUT - companies with the stalest comment letter")
    lines = [RULE, "  %s" % title,
             "  Census %s to %s | %s letters across %s registrants | universe: %s"
             % (census["from"], census["to"], format(census["letters"], ","),
                format(census["registrants"], ","), result["universe"]),
             RULE, ""]

    rows = result["rows"]
    if not rows:
        lines.append(_wrap("No rows matched."))
    elif result["screen"] == "active":
        lines.append("  %-7s %-38s %7s %8s %7s  %s"
                     % ("TICKER", "COMPANY", "LETTERS", "REVIEWS", "ROUNDS",
                        "LAST"))
        lines.append("  " + "-" * 74)
        for row in rows:
            lines.append("  %-7s %-38s %7d %8d %7d  %s"
                         % (row["ticker"] or "-", row["name"][:38],
                            row["letters"], row["threads"],
                            row["longest_thread_rounds"], row["last"]))
        lines.append("")
        lines.append(_wrap(
            "LETTERS counts individual staff letters. REVIEWS clusters them "
            "into separate reviews; ROUNDS is the most letters in any one "
            "review. Many rounds inside one review is friction. Many separate "
            "reviews is a filer the staff keeps coming back to."))
    else:
        lines.append("  %-7s %-40s %7s %10s  %s"
                     % ("TICKER", "COMPANY", "LETTERS", "YEARS", "LAST LETTER"))
        lines.append("  " + "-" * 74)
        for row in rows:
            years = ("%s%.1f" % (">=" if row.get("censored") else "  ",
                                 row["years_since"]))
            last = row["last"] or "none in census"
            if row.get("new_registrant"):
                last = "new CIK since %s" % row["registrant_since"]
            lines.append("  %-7s %-40s %7d %10s  %s"
                         % (row["ticker"] or "-", row["name"][:40],
                            row["letters"], years, last))
        lines.append("")
        lines.append(_wrap(
            ">= marks a floor rather than a measurement: the company's last "
            "letter sits at the edge of the census, so the real gap is at "
            "least this long and possibly much longer. Start the census "
            "earlier with --screen-from."))
        if result.get("never_in_window"):
            lines.append(_wrap(
                "%s %s in the universe drew no letter anywhere in the %s-year "
                "census.%s"
                % (format(result["never_in_window"], ","),
                   _plural(result["never_in_window"], "name"),
                   result.get("census_years", "?"),
                   " They are folded into the ranking above."
                   if result.get("never_included")
                   else " Add --include-never to rank them too.")))
        if any(row.get("new_registrant") for row in rows):
            lines.append(_wrap(
                "A row marked 'new CIK' is a registrant EDGAR has only held "
                "since that date - a spin-off, redomiciliation, or holding-"
                "company reorganisation. It has no letter history because it "
                "has no history, which is not the same as being overdue."))
        lines.append(_wrap(
            "A market-wide ranking ties thousands of names at the same floor. "
            "Point --watchlist at a file of your own tickers to get a list you "
            "can act on."))

    lines.append("")
    lines.append(THIN)
    lines.append(_wrap(SCREEN_CAVEAT))
    lines.append(THIN)
    return "\n".join(lines)


def render_json(result):
    return json.dumps(result, indent=2, default=str)
