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
4. **Scores what it read** into a directional lean, measured against the stock's
   own price history rather than against the letters in isolation.

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
| `--llm` | add narrative commentary (see below) |

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

### 3. Reading it against the price

For each staff letter, the bot measures the stock's return over the ten trading
days after the *filing date* — the date EDGAR made the letter public — net of
SPY. That is the "already priced in" term. The verdict works on what is left:

```
residual  = fundamental pressure  −  what the market already paid
composite = 0.80 × residual  +  0.20 × trend (price vs its 50/200-day averages)
```

The interesting case is not a bad letter. It is a bad letter the market ignored.
The reverse also reads: a review closed cleanly while the stock sold off is a
resolved overhang, not a new problem.

The composite maps to `UP` / `SLIGHTLY UP` / `NEUTRAL` / `SLIGHTLY DOWN` /
`DOWN`, plus a confidence grade from how much evidence was actually readable.
Every term is printed in the report — there is no hidden arithmetic.

## Optional narrative layer

`--llm` adds prose commentary on top of the computed result via the Anthropic
API. It changes no score and no direction. It needs the SDK and a credential:

```bash
pip install anthropic
export ANTHROPIC_API_KEY=...        # or: ant auth login
```

Without either, the flag prints a note and the run continues unchanged.

## What this tool will not tell you

- **Comment letters are public and late.** EDGAR releases them about 20 business
  days after the staff closes a review, so anyone paying attention has seen them
  before you. The event-study term exists precisely to measure that.
- **Most letters are noise.** Non-GAAP prominence and MD&A wording comments are
  the staff's day job. The taxonomy weights them low on purpose.
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
