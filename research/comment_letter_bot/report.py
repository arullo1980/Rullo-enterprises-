"""Rendering. Plain text for a terminal, JSON for anything downstream."""

import json
import textwrap

RULE = "=" * 78
THIN = "-" * 78

DISCLAIMER = (
    "SEC comment letters are a slow, sparse, public signal. EDGAR publishes "
    "them roughly 20 business days after the staff closes a review, so any "
    "informed party has seen them first. This tool is research support for "
    "your own process - not investment advice, and not an execution trigger."
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
        line = "Last trade: %s on %s" % (trade.get("side", "position").upper(),
                                         trade["date"])
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
        lines.append("  [%s] %s  %s" % (letter["filed"], label, letter["accession"]))
        if letter["topics"]:
            lines.append("  Topics: %s" % ", ".join(letter["topics"]))
        lines.append("  Letter score: %+.0f  (aged weight %.2f -> %+.0f)"
                     % (letter["score"], letter["weight"], letter["weighted"]))
        for bullet in letter["summary"]:
            lines.append(_bullet(bullet))
        if letter.get("event"):
            event = letter["event"]
            lines.append("  Market response over %d sessions: raw %s%s"
                         % (event["window"], _pct(event["raw"]),
                            "" if event.get("abnormal") is None
                            else ", vs benchmark %s" % _pct(event["abnormal"])))
        if letter.get("narrative"):
            lines.append(_wrap("LLM read: " + letter["narrative"], indent="  "))
        lines.append("  %s" % letter["url"])

    # -- price -------------------------------------------------------------
    lines.append("")
    lines.append(THIN)
    lines.append("  2. PRICE CONTEXT")
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
    lines.append("  3. READ: %s   (confidence: %s)"
                 % (verdict["direction"], verdict["confidence"]))
    lines.append(RULE)
    if verdict["headline"]:
        lines.append(_wrap(verdict["headline"]))
    lines.append("")
    lines.append("  Composite %+.1f = %.2f x residual %+.1f  +  %.2f x trend %+.1f"
                 % (verdict["composite"], 0.80, verdict["residual"],
                    0.20, verdict["momentum"]))
    lines.append("    fundamental pressure from letters : %+.1f"
                 % verdict["fundamental_pressure"])
    lines.append("    estimated already priced in       : %s"
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


def render_json(result):
    return json.dumps(result, indent=2, default=str)
