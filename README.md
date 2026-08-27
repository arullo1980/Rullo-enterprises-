# Rullo Enterprises — Storefront

A single-purpose storefront at **rulloenterprises.com** selling
[Reloadly's](https://www.reloadly.com/) full catalog — mobile airtime
top-ups, mobile data bundles, gift cards, and utility bill payments —
worldwide.

Plain static HTML/CSS. **No build step, no framework, no dependencies.**
Checkout runs entirely inside an embedded Reloadly "Plugin V2" widget, so
this codebase never sees or stores payment data.

---

## Project structure

```
.
├── site/                  # deploy this directory as the web root
│   ├── index.html         # homepage — hero, offerings, widget, how-it-works, FAQ
│   ├── 404.html           # on-brand not-found page
│   ├── privacy/
│   │   └── index.html     # privacy policy (DRAFT — see "Outstanding" below)
│   ├── css/
│   │   └── styles.css     # all styles, shared across pages
│   ├── js/
│   │   ├── config.js      # proxy URL — empty means "offline mode" (see below)
│   │   └── coverage.js    # searchable coverage explorer
│   ├── favicon.svg        # "RE" monogram in the site's ink/paper palette
│   ├── icons.svg          # SVG symbol sheet (currently unused)
│   ├── robots.txt
│   └── sitemap.xml
├── workers/
│   └── reloadly-proxy/    # Cloudflare Worker holding the Reloadly credentials
│       ├── src/           # worker.js, products.js, mock.js
│       ├── test/          # offline test suite — npm test
│       └── test.sh        # smoke test against a deployed Worker
├── _toolkit/
│   └── postmark.py        # two-machine work protocol (see CLAUDE.md)
├── CLAUDE_CODE_HANDOFF.md # full project brief, integration + deployment notes
└── README.md
```

The site uses **root-absolute paths** (`/css/styles.css`, `/favicon.svg`,
`/privacy/`), so `site/` must be served as the web root — both locally and
in production.

---

## Design system

"Ivory & Emerald" — a warm, premium, editorial look: an ivory ground,
Playfair serif headlines with an emerald italic accent, gold detailing, and
soft-shadow cards.

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#FAF7EF` | warm ivory background |
| `--bg-2` | `#F3EEE1` | alternate / tinted section |
| `--surface` | `#FFFDF8` | cards |
| `--ink` | `#1B1710` | primary text |
| `--ink-soft` | `#5E574A` | secondary text |
| `--line` | `#E7DFCC` | borders / hairlines |
| `--emerald` | `#0E7C55` | primary brand color (CTAs, accent line) |
| `--gold` | `#B8963F` | secondary accent (labels, card tops, detailing) |
| `--band` | `#0B5C40` | emerald CTA band |
| `--ink-deep` | `#17130C` | footer |

**Type:** Playfair Display (display / headlines) · Inter (body) · IBM Plex
Mono (labels, numbers, data).

Patterns: a two-tone serif hero headline (ink + emerald italic), gold
monospace micro-labels, feature pills, gold-topped soft-shadow cards, an
app-window frame around the widget, and an accordion FAQ.

---

## Local preview

Because the site relies on root-absolute paths, serve `site/` as the root
rather than opening the file directly:

```bash
cd site
python3 -m http.server 8000
# then open http://localhost:8000
```

> Note: the Reloadly widget loads from `cdn.reloadly.com`. If your network
> can't reach that CDN, the storefront panel will render empty locally —
> that's expected and not a bug in this code.

---

## Deployment

Target: **GitHub Pages**, custom domain **rulloenterprises.com**. Deploys
automatically from `.github/workflows/deploy.yml` on every push to `main`
that touches `site/` — no manual uploads. `404.html` is served for
unmatched routes; `CNAME` pins the custom domain; `.nojekyll` serves files
untouched.

**One-time setup (in this order):**

1. **Repo → Settings → Pages → Build and deployment → Source:** select
   **GitHub Actions**. (The workflow attempts to set this automatically on
   its first run; only do it by hand if that run reports Pages isn't
   enabled.)
2. **DNS at IONOS** — add these records for the apex domain (this is a
   record change only; **no nameserver migration** needed):

   | Type | Name | Value |
   | --- | --- | --- |
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | CNAME | `www` | `arullo1980.github.io` |

   (Optionally add the four `AAAA` records for IPv6 — see GitHub's
   "Managing a custom domain" docs. Verify the IPs there too; they're
   GitHub's published Pages addresses but worth a sanity check.)
3. **Repo → Settings → Pages → Custom domain:** enter
   `rulloenterprises.com`, save, then tick **Enforce HTTPS** once the
   certificate is issued (can take a few minutes to an hour).

Delete any old IONOS A/CNAME record for the domain that still points at the
former WordPress app, so it doesn't compete with the records above. If
email is hosted on this domain, leave its `MX` records untouched.

> Alternative (from the original handoff): Cloudflare Pages via Direct
> Upload with output dir `site`. See `CLAUDE_CODE_HANDOFF.md` for that plan
> and its DNS/MX notes.

---

## Reloadly integration

A **no-code embed** — there are no backend credentials or secrets in this
repo.

```html
<reloadly-widget data-widget-id="qEM4TYgz5qYBoBXWiyp6XZL10GnKhexHbWZt0ebEeM"></reloadly-widget>
<script src="https://cdn.reloadly.com/widget/v2/reloadly-widget.js" defer></script>
```

Widget behavior, theme, supported countries, and the payment-processor
connection are all configured in the **Reloadly dashboard**, not here.
Checkout happens entirely inside the widget, so this codebase never sees or
stores payment data.

### The API proxy

`workers/reloadly-proxy/` is a Cloudflare Worker that holds the Reloadly API
credentials server-side and exposes **read-only** endpoints the static site can
call. The browser never sees a secret; it only ever calls the Worker. It covers
all three Reloadly APIs — top-ups, gift cards, and utilities — behind one
`/coverage?country=XX` call.

Credentials have not been issued yet, so the Worker ships with a **mock mode**
that serves fixture data in the real API's shape. That is how the front end was
wired and tested without an account:

```bash
cd workers/reloadly-proxy
npm test          # 18 offline tests — routing, validation, CORS, caching
npm run dev:mock  # local Worker on fixture data
```

**Live coverage is off until someone turns it on.** `site/js/config.js` has an
empty `apiBase`; with it empty the site behaves exactly as it does today. Set
it to a deployed Worker URL and the coverage explorer additionally shows the
real operators, brands, and billers per country. If the proxy is unset, slow,
or down, the panel keeps its offline content — live data is strictly additive.

Full instructions in [`workers/reloadly-proxy/README.md`](workers/reloadly-proxy/README.md).

A fully custom checkout (operator → amount → recipient → Stripe → Reloadly
order) is the larger follow-on and needs write access to the Reloadly API. It
is deliberately not started.

---

## Outstanding

Tracked in detail in `CLAUDE_CODE_HANDOFF.md`:

1. **Privacy policy is a draft** — `site/privacy/index.html` has bracketed
   `[confirm…]` sections and is `noindex` on purpose. Needs real legal
   review before it's finished and made indexable.
2. **Widget not yet visually confirmed live** — first check after deploy:
   does it render and complete a test transaction?
3. **Reloadly API credentials not issued** — the proxy is written, tested, and
   ready, but cannot be deployed against the real API until credentials exist
   at developers.reloadly.com. Until then it runs on fixtures.
4. **Cloudflare Workers build is failing** on the `rullo-enterprises` service.
   The build config lives in the Cloudflare dashboard, not this repo; it needs
   its root directory set to `workers/reloadly-proxy`.
5. **Footer contact email and social links are placeholders** — the
   Instagram/Facebook/X links point at bare platform homepages, not real
   Rullo Enterprises accounts.

---

<!-- POSTMARK:BEGIN -->

## Work Postmark

_Maintained by `_toolkit/postmark.py`. Each machine stamps its row when it
finishes a session. Do not edit by hand; never delete another machine row._

| Machine | Last touched (UTC) | Branch | Commit | Summary |
| ------- | ------------------ | ------ | ------ | ------- |
| Antonio | 2026-08-27 00:51 | antonio/work-protocol | 0723700 | Install shared two-machine work protocol |

<!-- POSTMARK:END -->
