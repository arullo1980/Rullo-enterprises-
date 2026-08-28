# Broadcast Desk

A social operations console for running many accounts at once — your own, your
business's, and clients' accounts you post on behalf of.

It is a desktop app. Credentials stay on your machine, encrypted by the OS
keyring; your clients' video masters never leave your disk unless a network
insists on fetching them itself. A small Cloudflare Worker does the three jobs a
program on your desk cannot: taking OAuth callbacks from networks that refuse a
local address, hosting media for Instagram, and sending scheduled posts while
the machine is off.

```
broadcast-desk/
├── main/        Electron main process — vault, OAuth, sending, scheduler
├── renderer/    the console UI — no secrets, no network calls of its own
├── shared/      network catalogue and adapters, used by all three runtimes
├── worker/      the relay (Cloudflare Worker)
└── docs/        SETUP.md — start here.  CONSOLE.md — how to use it
```

```sh
npm install && npm start        # run it
npm run dist:win                # build an installer
npm test                        # main-process and worker tests, no network
```

---

## Networks

| Network | Post | Reply | Repost | Like | Media | Before you can post for clients |
| --- | --- | --- | --- | --- | --- | --- |
| X | ✅ | ✅ | ✅ | ✅ | ✅ | Paid API. $0.015/post, **$0.20 with a link** |
| Instagram | ✅ | — | — | — | required | Meta app review + business verification |
| TikTok | ✅ | — | — | — | video | Content Posting audit, or posts stay private |
| Facebook Page | ✅ | ✅ | — | — | ✅ | Meta app review. Pages only |
| Telegram | ✅ | ✅ | — | — | ✅ | Nothing — a bot token |
| Discord | ✅ | — | — | — | ✅ | Nothing — a channel webhook |
| Reddit | ✅ | ✅ | — | ✅ | link | Nothing — a free app |
| Tumblr | ✅ | — | ✅ | — | ✅ | Nothing — a free app |
| WordPress | ✅ | ✅ | — | — | ✅ | Nothing — an Application Password |
| Vimeo | ✅ | — | — | — | video | Nothing — a free app |
| Pinterest | ✅ | — | — | — | required | Trial app; short review for standard access |
| Bluesky, Mastodon, LinkedIn | ✅ | ✅ | ✅ | ✅ | ✅ | Also built in, at no extra cost |

Full credential guide, per network: [docs/SETUP.md](docs/SETUP.md).

---

## What it does

- **Profiles** — personal, business and client identities, each with its own
  accounts, timezone, voice notes and slice of the library.
- **A keyword and phrase library** — tagged, weighted, restrictable to
  particular profiles and networks.
- **A message generator** — nestable spintax with weights, library tokens like
  `[phrase:value]`, exact pool-size counting rather than an estimate, and
  least-recently-used rotation so consecutive posts do not repeat themselves.
- **Simultaneous posting** to any set of accounts, with per-network previews,
  real character limits, and a different spin per account by default.
- **Scheduling** — fixed slots with scatter, or randomised intervals; drip
  campaigns that lay a generated pool across a calendar.
- **Rules** — reply, quote, repost, like and mention, with triggers, filters,
  rate caps and active hours, a plain-English summary that updates as you build,
  and a simulator that shows what a rule would do before you switch it on.

---

## The rules the code enforces

Not documentation — behaviour, with tests.

**No credential is ever written to the workspace database.** Tokens go to the OS
keyring via the main process. The renderer cannot read one, and a copy reaches
the relay only for accounts you explicitly switch to unattended.

**Client accounts are connected by the client authorising the app.** Never by
collecting a password. That survives their password changes and two-factor, and
they can revoke it themselves.

**Nothing is reported as sent when it was simulated.** Dry run is a visible
setting, on by default, and every simulated result says so.

**X link posts are refused by default**, and a monthly spend cap is checked
before the request is made — so a misconfigured rule cannot run up a bill.

**TikTok says when a post is private.** Until the audit passes, uploads are
`SELF_ONLY`; the result says so rather than claiming a public post.
