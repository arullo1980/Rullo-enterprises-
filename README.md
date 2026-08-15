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

Clean, modern, and professional — an emerald brand color, bold display
type, soft-shadow cards, and rounded pills. Built to read like a real
product, not a template.

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#F6F7F5` | page background |
| `--bg-2` | `#EEF1EE` | alternate / tinted section |
| `--surface` | `#FFFFFF` | cards |
| `--ink` | `#10201A` | primary text |
| `--ink-soft` | `#55635C` | secondary text |
| `--line` | `#E4E8E4` | borders / hairlines |
| `--accent` | `#0F9E70` | emerald brand color |
| `--accent-dark` | `#0B7B57` | hover / emphasis |
| `--ink-deep` | `#0C1A15` | dark CTA band + footer |

**Type:** Space Grotesk (display / headlines) · Inter (body) · IBM Plex
Mono (labels, numbers, data).

Patterns: a two-tone hero headline, monospace micro-labels, rounded feature
pills, soft-shadow cards with a subtle hover lift, an app-window frame
around the widget, and an accordion FAQ.

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
