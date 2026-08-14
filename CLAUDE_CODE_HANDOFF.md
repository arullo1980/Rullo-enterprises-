# Rullo Enterprises Storefront — Handoff Brief for Claude Code

## What this is

A single-purpose storefront at **rulloenterprises.com** selling Reloadly's
full catalog — mobile airtime top-ups, mobile data bundles, gift cards, and
utility bill payments — worldwide. This replaced an earlier multi-page site
(insurance/mortgage/tax services + a portfolio of in-house apps). That
content is gone on purpose; this domain is now dedicated entirely to the
Reloadly storefront.

The site currently lives in `site/` alongside this document — plain static
HTML/CSS, no build step, no framework. It renders correctly locally but has
**not yet gone live** (see Deployment status below).

---

## Reloadly integration — what you actually have

This is a **no-code embed**, not an API integration. There are no backend
credentials, no server-side calls, no secrets to store.

- **Widget ID:** `qEM4TYgz5qYBoBXWiyp6XZL10GnKhexHbWZt0ebEeM`
- **Embed markup** (already in `site/index.html`):
  ```html
  <reloadly-widget data-widget-id="qEM4TYgz5qYBoBXWiyp6XZL10GnKhexHbWZt0ebEeM"></reloadly-widget>
  <script src="https://cdn.reloadly.com/widget/v2/reloadly-widget.js" defer></script>
  ```
- The widget is Reloadly's "Plugin V2" — it renders its own search, product
  selection, and checkout UI inside that custom element. Payment processing
  (Stripe, per Reloadly's setup) happens entirely inside the widget.
  Rullo Enterprises never sees or stores card data.
- Widget behavior, theme color, and payment processor connection are
  configured inside the **Reloadly dashboard**, not in this codebase. If
  something about the widget's behavior needs to change (colors, supported
  countries, etc.), that's done there, not in the HTML/CSS here.
- **If a future task calls for deeper integration** (custom checkout flow,
  programmatic order placement, server-side product lookups), that requires
  actual Reloadly API credentials (client ID + secret) from
  developers.reloadly.com — which have not been issued/provided yet. Don't
  assume they exist; ask the user before building anything that requires them.

---

## Design system

Deliberately **not** a generic AI-template look (cream background + gold
accent + serif headlines + card grids was tried and rejected as "tacky").
Current direction is a document/filing-register aesthetic — flat, no
rounded corners, no drop shadows, no hover-lift cards.

**Tokens** (defined in `site/css/styles.css`):
```css
--paper: #F0EDE3;       /* background */
--paper-2: #E7E2D3;      /* alternate section background */
--line: #C7BFA9;         /* hairline rules */
--ink: #1B1A15;           /* primary text / dark sections */
--ink-soft: #57544A;      /* secondary text */
--ink-faint: #8B8676;     /* tertiary/label text */
--white: #FAF8F2;
--stamp: #A13327;         /* rare accent — status/stamp only */
--carbon: #2E3E63;        /* link/interactive accent */
```

**Type:** PT Serif (headlines) + IBM Plex Sans (body) + Courier Prime
(labels, numbers, data — mimics a typewriter/filed-document feel).

Layout patterns already established: a "schedule" list (numbered rows, not
cards) for the four product categories, a bordered "widget frame" panel for
the embed, numbered §-style section labels. Keep new sections consistent
with this — avoid reintroducing rounded-corner card grids or a gold/cream
palette.

---

## File structure

```
site/
├── index.html          # homepage — hero, offerings, widget, how-it-works, FAQ
├── privacy/
│   └── index.html       # privacy policy — DRAFT, see below
├── css/
│   └── styles.css       # all styles, shared by both pages
├── robots.txt
├── sitemap.xml
├── favicon.svg
└── icons.svg
```

Real static files — `/privacy/` is an actual folder with an actual
`index.html`, not client-side routing. No `.htaccess` or rewrite rules
needed for routing to work.

---

## Outstanding / needs attention

1. **Privacy policy is a placeholder.** `site/privacy/index.html` has
   bracketed `[confirm...]` sections (cookie/analytics disclosure, exact
   data fields the widget collects, contact email) and is marked
   `noindex` on purpose. Needs real legal review before it's finished and
   made indexable — don't just fill in the brackets with guesses.
2. **Widget has not been visually confirmed live.** It was built and
   embedded correctly per Reloadly's docs, but the environment used to
   build this couldn't reach `cdn.reloadly.com` to test rendering. First
   thing to check once deployed: does the widget actually render and
   complete a test transaction flow.
3. **Contact email, "last updated" date, and social links in the footer
   are placeholders** — Instagram/Facebook/X links point at the bare
   platform homepages, not real Rullo Enterprises accounts.

---

## Deployment status

- **Original plan:** upload directly to existing IONOS hosting (same
  account previously running WordPress at this domain).
- **Blocked:** the domain's "destination" in IONOS is tied to a managed
  WordPress app connection, and "Connect to webspace" is greyed out /
  unavailable even after resetting the domain — looks like the domain and
  the webspace may be in separate IONOS contracts. Unresolved as of this
  writing.
- **Current plan:** move off IONOS DNS entirely — point the domain's
  nameservers at Cloudflare, and host the static site on Cloudflare Pages
  (Direct Upload, no build step needed since these are already plain
  files). This was **in progress, not completed** — nameservers had not
  yet been switched as of this handoff.
- **Before switching nameservers:** check IONOS for any existing MX
  records (email hosted on this domain) and make sure they get recreated
  in Cloudflare's DNS after import — Cloudflare's site-add flow scans and
  imports existing records automatically, but that import should be
  double-checked against what's actually in use before cutting over.

---

## What "done" looks like

- Site live at rulloenterprises.com via Cloudflare Pages
- Reloadly widget confirmed rendering and functional in a real browser
- Privacy policy finished (real content, legal-reviewed) and un-noindexed
- Footer social links and contact email are real
