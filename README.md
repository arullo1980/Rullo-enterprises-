# Rullo Enterprises

Two separate products share this repository:

1. **The storefront** at **rulloenterprises.com** — selling
   [Reloadly's](https://www.reloadly.com/) full catalog: mobile airtime
   top-ups, mobile data bundles, gift cards, and utility bill payments,
   worldwide. Plain static HTML/CSS, no build step, no dependencies.
2. **[Broadcast Desk](broadcast-desk/README.md)** — a desktop social
   operations console for running many accounts at once: your own, the
   business's, and clients' accounts you post on behalf of. Electron app plus
   a small Cloudflare Worker. Self-contained in `broadcast-desk/` and ready to
   split into its own repository.

The storefront's checkout runs entirely inside an embedded Reloadly "Plugin V2"
widget, so this codebase never sees or stores payment data. Broadcast Desk keeps
social tokens in the OS keyring and never writes one to its own database — same
principle, different secret.

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
│   │   └── styles.css     # storefront styles
│   ├── favicon.svg        # "RE" monogram in the site's ink/paper palette
│   ├── icons.svg          # SVG symbol sheet (currently unused)
│   ├── robots.txt
│   └── sitemap.xml
├── workers/
│   └── reloadly-proxy/    # read-only Reloadly API proxy for the storefront
├── broadcast-desk/        # the desktop product — see its own README
│   ├── main/              # Electron main process: vault, OAuth, sending
│   ├── renderer/          # the console UI
│   ├── shared/            # network catalogue + adapters (app, relay, UI)
│   ├── worker/            # the relay (Cloudflare Worker)
│   ├── test/              # node test/run.mjs — no network, no Electron
│   └── docs/              # SETUP.md, CONSOLE.md
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

## Broadcast Desk

A desktop app for running many social accounts at once — yours, the business's,
and clients' accounts you operate on their behalf. Profiles, a keyword and
phrase library, a TweetAdder-style message generator, simultaneous posting,
scheduling and drip campaigns, and ad-hoc rules for replies, reposts and
mentions.

Eleven networks are wired: X, Instagram, TikTok, Facebook, Telegram, Discord,
Reddit, Tumblr, WordPress, Vimeo and Pinterest — plus Bluesky, Mastodon and
LinkedIn, which came free.

```sh
cd broadcast-desk
npm install && npm start     # run it
npm test                     # 36 tests, no network, no Electron needed
npm run dist:win             # build an installer
```

It is a desktop app because that is where the credentials and the client video
masters belong. A small Cloudflare Worker (`broadcast-desk/worker/`) does the
three things a program on your desk cannot: take OAuth callbacks from networks
that refuse a local redirect, host media for Instagram, and send scheduled posts
while the machine is off.

Read [`broadcast-desk/README.md`](broadcast-desk/README.md) first, then
[`docs/SETUP.md`](broadcast-desk/docs/SETUP.md) for per-network credentials.

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

---

<!-- POSTMARK:BEGIN -->

## Work Postmark

_Maintained by `_toolkit/postmark.py`. Each machine stamps its row when it
finishes a session. Do not edit by hand; never delete another machine row._

| Machine | Last touched (UTC) | Branch | Commit | Summary |
| ------- | ------------------ | ------ | ------ | ------- |
| ClaudeWeb | 2026-08-28 18:13 | claude/social-media-management-platform-0ak8tg | b2eaf1f | Rebuild Broadcast Desk as a standalone Electron desktop product (11 networks) |
| Antonio | 2026-08-27 00:51 | antonio/work-protocol | 0723700 | Install shared two-machine work protocol |

<!-- POSTMARK:END -->
