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
│   ├── favicon.svg        # "RE" monogram in the site's ink/paper palette
│   ├── icons.svg          # SVG symbol sheet (currently unused)
│   ├── robots.txt
│   └── sitemap.xml
├── CLAUDE_CODE_HANDOFF.md # full project brief, integration + deployment notes
└── README.md
```

The site uses **root-absolute paths** (`/css/styles.css`, `/favicon.svg`,
`/privacy/`), so `site/` must be served as the web root — both locally and
in production.

---

## Design system

A deliberate document / filing-register aesthetic — flat, no rounded
corners, no drop shadows, no hover-lift cards. (A generic
cream + gold + serif card-grid look was tried and rejected.)

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#F0EDE3` | background |
| `--paper-2` | `#E7E2D3` | alternate section background |
| `--line` | `#C7BFA9` | hairline rules |
| `--ink` | `#1B1A15` | primary text / dark sections |
| `--ink-soft` | `#57544A` | secondary text |
| `--ink-faint` | `#8B8676` | tertiary / label text |
| `--stamp` | `#A13327` | rare accent — status/stamp only |
| `--carbon` | `#2E3E63` | link / interactive accent |

**Type:** PT Serif (headlines) · IBM Plex Sans (body) · Courier Prime
(labels, numbers, data).

When adding sections, keep to these patterns (numbered "schedule" rows,
bordered "widget frame" panels, `§`-style section labels). Avoid
reintroducing rounded-corner card grids or a gold/cream palette.

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

Target: **Cloudflare Pages** (Direct Upload — no build needed).

- Build command: *(none)*
- Output / upload directory: **`site`**

`404.html` at the site root is served automatically by Cloudflare Pages for
unmatched routes. See `CLAUDE_CODE_HANDOFF.md` for the full deployment
history, the IONOS → Cloudflare DNS migration plan, and the MX-record
checklist to complete before switching nameservers.

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
Anything requiring deeper integration (custom checkout, programmatic
orders) would need Reloadly API credentials that have not been issued —
don't assume they exist.

---

## Outstanding

Tracked in detail in `CLAUDE_CODE_HANDOFF.md`:

1. **Privacy policy is a draft** — `site/privacy/index.html` has bracketed
   `[confirm…]` sections and is `noindex` on purpose. Needs real legal
   review before it's finished and made indexable.
2. **Widget not yet visually confirmed live** — first check after deploy:
   does it render and complete a test transaction?
3. **Footer contact email and social links are placeholders** — the
   Instagram/Facebook/X links point at bare platform homepages, not real
   Rullo Enterprises accounts.
