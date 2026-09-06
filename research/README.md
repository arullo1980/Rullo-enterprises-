# SEC comment-letter bot

A command-line research tool for one question:

> Since I last traded this name, has the SEC's Division of Corporation Finance
> asked the company anything that should change my view — and has the market
> already paid for it?

It is not part of the storefront. `site/` is the deployed web root and this
directory is never published; nothing here touches the Reloadly integration.

---

## What it does

1. **Asks for a ticker** (or takes one as an argument).
2. **Scans EDGAR** for the two forms that carry a filing review:
   - `UPLOAD` — the SEC staff's comment letter to the company
   - `CORRESP` — the company's written response back
3. **Asks whether and when you last traded the name**, and reads every letter
   filed since then. With no prior trade it falls back to a three-year window.
4. **Reads the private window** — the weeks or months between a letter being
   written and EDGAR releasing it — for insider and institutional filings by
   the people who could already see it.
5. **Scores what it read** into a directional lean, measured against the stock's
   own price history rather than against the letters in isolation.

It also runs two market-wide screens: **most active** (who is drawing the most
comment letters) and **longest without** (whose last letter is stalest).

Everything except the optional narrative layer is deterministic: no model is
required, and the same inputs always produce the same score.

## Running it

```bash
export SEC_USER_AGENT="Your Name your@email"   # EDGAR requires a contact
python3 research/clbot.py                      # interactive
python3 research/clbot.py AAPL --last-trade 2024-01-15 --side buy --entry-price 180
python3 research/clbot.py GT --json | jq .verdict
```

Python 3.8+, standard library only. No `pip install`, no build step — the same
zero-dependency rule the rest of this repository follows.

| Flag | Effect |
| --- | --- |
| `--last-trade YYYY-MM-DD` | anchor the window to your last fill |
| `--side buy\|sell\|short\|hold`, `--entry-price` | position P&L on that fill |
| `--lookback-days N` | window when there is no prior trade (default 1095) |
| `--limit N` | cap how many filings are fetched and read |
| `--no-prices` | filings only; skip the price feed entirely |
| `--no-input` | never prompt — for cron, pipes, and scripts |
| `--no-cache` | bypass the on-disk response cache |
| `--json` | machine-readable output |
| `--full-text ACCESSION` | dump one letter's extracted text and exit |
| `--no-insiders` | skip the private-window insider scan |
| `--llm` | add narrative commentary (see below) |

Screens (no ticker needed):

| Flag | Effect |
| --- | --- |
| `--screen active` | companies drawing the most comment letters |
| `--screen overdue` | companies whose last comment letter is stalest |
| `--screen-years N` | years of history to census (default 10) |
| `--watchlist FILE` | restrict a screen to your own tickers, one per line |
| `--listed-only` | on `--screen active`, drop filers with no current ticker |
| `--include-never` | rank names with no letter anywhere in the census |
| `--screen-limit N` | rows to print (default 25) |

## How the read is built

### 1. Reading the letter

Staff comment letters are filed as scanned PDFs, but EDGAR attaches a
machine-generated `TEXT-EXTRACT` document beside each one. The bot prefers that
document, which is why it needs no PDF library. It then:

- strips the running headers, footers, and page numbers the extractor leaves
  interleaved with the prose (they otherwise truncate the sentence they land in);
- splits the letter into its numbered comments and the section headings
  (`Note 16. Revision of Previously Issued Financial Statements, page 33`) each
  one refers to;
- in a `CORRESP`, separates the staff comment the company quotes from the
  company's own answer, so a response is never scored as if it were a fresh
  demand;
- classifies administrative traffic — Rule 461 acceleration requests,
  withdrawals, "we do not intend to review your registration statement" — which
  arrives on the same forms and carries no accounting content.

### 2. Scoring it

`taxonomy.py` holds the whole opinion in one table: roughly two dozen comment
subjects, each with a weight on a 0–40 scale. Restatement and non-reliance
language sits at the top; material weakness, going concern and revenue
recognition just below; risk-factor and executive-compensation housekeeping at
the bottom. Tone is scored separately — a reissued comment, an explicit
disagreement, or a demand to amend a filed report all add pressure.

Per letter: the heaviest topic counts in full and each further topic at a
declining discount (one letter about six things is not six letters). A letter in
which the staff writes *"we have completed our review"* scores positively — that
is the overhang ending. Scores then decay with a 270-day half-life, because a
comment letter from three years ago is a fact about history, not a live risk.

### 3. The private window

This is the part that took a correction to get right, and it matters more than
anything else in the tool.

**The date on a comment letter is not the date the market saw it.** EDGAR holds
a review thread back and disseminates the whole thing in one batch once the
staff closes the review. `filingDate` in the submissions API is the date typed
on the letter; the real release date is stamped in the submission header and
marked `<PRIVATE-TO-PUBLIC>`. The gap is not the "20 business days" the SEC's
policy statement implies — that clock starts when the *review* closes, not when
each letter is written:

| Company | Letters dated | Released | Window |
| --- | --- | --- | --- |
| Apple | 2024-03-06 → 2024-05-16 | 2024-06-14 | 100 days |
| Goodyear | 2025-09-10 → 2025-09-29 | 2026-01-27 | 139 days |

Everything price-related therefore anchors on the **dissemination date**, and
the window before it is reported on its own terms.

Inside that window the company knew what the staff was challenging and the
market did not. The bot reads the issuer's own filing feed across exactly those
dates for Form 4 (insider transactions), Form 144 (an affiliate's notice of
intent to sell), and Schedule 13D/G amendments, and reports what it finds.

Three things keep this from manufacturing a signal out of noise:

- **Only open-market trades count.** Grants, option exercises, and tax
  withholding happen on a schedule nobody chose this month.
- **Rule 10b5-1 plan trades are separated out.** Form 4 carries a flag for
  them; a sale scheduled a year in advance is not a decision made inside the
  window. They are reported and never scored.
- **The window is only scored when the pending letter was substantive.**
  Insiders selling while the staff quibbles about non-GAAP prominence means
  nothing, and the scorer says so rather than counting it.

Form 4 has a two-business-day filing deadline, so trades late in a window are
reported after it closes. The scan searches filings a few days past the window
and then filters on the *transaction* date.

Nothing here alleges wrongdoing, and the tool does not say it does. It reports
who traded, when, how much, and whether it was scheduled.

### 4. Reading it against the price

For each staff letter, the bot measures the stock's return over the ten trading
days after the *dissemination date* — the first moment the market could price
it at all — net of SPY. That is the "already priced in" term. Letters are also
aged from that date, so a letter written in September and released in January
is a week old as news, not five months old.

```
fundamental = letter pressure  +  private-window insider pressure
residual    = fundamental  −  what the market already paid
composite   = 0.80 × residual  +  0.20 × trend (price vs its 50/200-day averages)
```

The interesting case is not a bad letter. It is a bad letter the market ignored.
The reverse also reads: a review closed cleanly while the stock sold off is a
resolved overhang, not a new problem.

The composite maps to `UP` / `SLIGHTLY UP` / `NEUTRAL` / `SLIGHTLY DOWN` /
`DOWN`, plus a confidence grade from how much evidence was actually readable.
Every term is printed in the report — there is no hidden arithmetic.

## The screens

```bash
python3 research/clbot.py --screen active --screen-years 5
python3 research/clbot.py --screen overdue --watchlist my-names.txt --include-never
```

Both are built from a **census** of every comment letter EDGAR has released in a
date range, assembled from EDGAR full-text search — 100 hits per request,
filtered by form server-side, deduplicated by accession number. The obvious
alternative, EDGAR's quarterly full indexes, is authoritative but costs about
50 MB per quarter: four gigabytes for a decade. Full-text search does the same
job in roughly 700 requests, or under three minutes, and every response is
cached, so later runs are nearly free.

**`--screen active`** ranks by letter count, and separates two different facts:
`REVIEWS` clusters letters into distinct reviews, `ROUNDS` is the most letters
inside any single one. Many rounds in one review is friction. Many separate
reviews is a filer the staff keeps coming back to. A cluster breaks on a gap of
150 days *or* a span of 18 months, so a serial filer with a steady drip of
letters is not reported as one imaginary review with forty rounds.

Unfiltered, this screen is topped by serial Reg A+ and shelf filers — every
offering draws comments and none of them are listed. **`--listed-only`**
restricts it to filers that currently have a ticker, which is almost always
what you want.

**`--screen overdue`** is the one to be careful with. Sarbanes-Oxley section 408
obliges the staff to review every reporting company at least once every three
years, which is what makes a long gap interesting — but:

- A review can close with **no letter at all**. No letter is evidence of no
  written comments, not proof of no review.
- Recent letters are still inside their private window and invisible.
- A census has an edge. A company whose last letter sits at the start of the
  window has an unknown true gap, so those rows are marked `>=` — a floor, not
  a measurement. This is why the default census is ten years deep.
- A registrant that reorganised, spun off, or redomiciled gets a **new CIK with
  no history**, which looks maximally overdue for the least interesting reason
  there is. On a watchlist-sized run the screen checks each silent name's first
  EDGAR filing and marks those rows `new CIK`.
- Market-wide, thousands of names tie at that floor and nothing in this data
  breaks the tie. **`--watchlist` is what makes this screen actionable**: point
  it at your own names and the ranking becomes a list you can work.

## Optional narrative layer

`--llm` adds prose commentary on top of the computed result via the Anthropic
API. It changes no score and no direction. It needs the SDK and a credential:

```bash
pip install anthropic
export ANTHROPIC_API_KEY=...        # or: ant auth login
```

Without either, the flag prints a note and the run continues unchanged.

## What this tool will not tell you

- **Comment letters are public and late.** EDGAR releases a review thread in one
  batch after the staff closes it — often weeks, sometimes months, after the
  letters were written. By the time you can read one, anyone paying attention
  has seen it too. The event-study term exists precisely to measure that.
- **Most letters are noise.** Non-GAAP prominence and MD&A wording comments are
  the staff's day job. The taxonomy weights them low on purpose, and a topic
  mentioned once in passing earns only half its weight — a letter that says
  "revenue recognition" in a heading is not a letter about revenue recognition.
- **The window drives the answer.** A three-year lookback on the same ticker can
  read differently from an eighteen-month one; the report always states which
  window it used and what anchored it.
- **No letters is not good news.** Most registrants are not under review in any
  given year. That case returns `NO SIGNAL`, never a buy.
- This is research support, not investment advice, and not an execution trigger.

## Layout

```
research/
├── clbot.py                    # launcher: python3 research/clbot.py TICKER
├── comment_letter_bot/
│   ├── cli.py                  # prompts, flags, and the run orchestration
│   ├── config.py               # endpoints, weights, and tunables
│   ├── http.py                 # rate-limited, retried, disk-cached fetcher
│   ├── edgar.py                # ticker -> CIK, filing history, text extraction
│   ├── letters.py              # letter parsing and per-letter analysis
│   ├── taxonomy.py             # comment subjects, weights, and tone patterns
│   ├── insiders.py             # private-window Form 4 / 144 / 13D-G scan
│   ├── census.py               # market-wide letter census and the screens
│   ├── prices.py               # daily closes, event study, price snapshot
│   ├── scoring.py              # the composite and the verdict bands
│   ├── report.py               # text and JSON rendering
│   └── llm.py                  # optional narrative layer
└── tests/                      # offline unit tests over fixed EDGAR fixtures
```

Run the tests from the repository root:

```bash
python3 -m unittest discover -s research/tests -t research
```

They are fully offline — the fixtures are trimmed real EDGAR submissions — so
they never depend on the SEC being up or on a company's filing history changing.

## Etiquette

EDGAR is a public good with published rules. The fetcher identifies itself from
`SEC_USER_AGENT`, throttles below the SEC's stated request ceiling, retries with
backoff, and caches every response to disk (`~/.cache/sec-comment-letter-bot`,
or `COMMENT_LETTER_BOT_CACHE`). Set a real contact address before any serious
use; unidentified traffic gets throttled and then blocked.

## Possible extensions

- A screen rather than a lookup: EDGAR full-text search (`efts.sec.gov`) can
  return every `UPLOAD` mentioning "material weakness" in a date range, which
  would turn this from a per-ticker tool into a watchlist generator.
- Back-testing the weights in `taxonomy.py` against forward returns. They are
  currently one analyst's priors, deliberately kept in a single table so they
  can be argued with and measured.
