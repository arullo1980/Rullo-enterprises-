# Using Broadcast Desk

How the console works once it is installed. For installing and connecting it,
see [SETUP.md](SETUP.md).

You operate every account here; clients authorise once and never see this app.

---

## The shape of it

| Section | What it is for |
| --- | --- |
| **Dashboard** | What is set up, what is about to go out, what just happened |
| **Compose** | Write once, send to many, with per-network previews |
| **Queue** | The schedule and the history, with a month calendar |
| **Inbox** | What the rules found and what they want to do about it |
| **Library** | The keywords and phrases the generator draws from |
| **Rules** | Ad-hoc automation: reply, repost, like, mention |
| **Profiles** | Personal / business / client identities |
| **Connections** | The social accounts each profile posts through |
| **Settings** | Backend, safety defaults, backup and restore |

`g` then a letter jumps between them — `g c` for Compose, `g q` for Queue.

---

## Profiles, and why client work is different

A **profile** groups the accounts you post as. Three kinds:

- **Personal** — your own accounts.
- **Business** — a company's accounts.
- **Client** — someone else's accounts, managed on their behalf. Carries the
  engagement details and its own timezone, and is the unit you hand back or
  delete when the work ends.

Every profile has its own voice notes, its own slice of the library, and its own
accounts. The working-profile selector in the sidebar scopes the entire console,
so a client's vocabulary cannot leak into your personal timeline by accident.

**A client's accounts are connected by the client authorising this app** on each
network — not by them sending you a password. That is not a formality:

- An authorisation survives their password changes and two-factor.
- It can be revoked by them, from their own account settings, without involving
  you.
- Holding a customer's password is a liability you take on personally, and on
  most networks it breaks the terms both of you agreed to.

The console never asks for a network password. Tokens are held by the app's main
process and encrypted by the OS keyring; the window you are looking at cannot
read one.

---

## The message generator

The heart of it, and the part the old desktop tools (TweetAdder and its
descendants) actually got right: write one template, get a pool of distinct
messages, so a campaign does not read as the same sentence pasted forty times.

Two mechanisms compose.

**Spintax** — inline alternatives, nestable:

```
{Heads up|Quick one}: {we do|Rullo Enterprises does} this {well|properly}.
```

Weight an option with `^n` when one should come up more often:

```
{usually this^5|occasionally that^1}
```

**Library tokens** — a draw from the keyword/phrase database, optionally
narrowed by tag:

| Token | Draws |
| --- | --- |
| `[keyword]` `[keyword:fintech]` | a subject you post about |
| `[phrase]` `[phrase:value]` | a whole sentence |
| `[hashtag]` | a tag, stored with its `#` |
| `[link]` | a URL you rotate through — mind what a link costs on X |
| `[cta]` | "Have a look:", "Details:" |
| `[emoji]` | kept separate so posts can go without |

And tokens that come from the post's context rather than the library:
`[handle]`, `[account]`, `[profile]`, `[platform]`, `[date]`, `[time]`,
`[day]`, plus `[author]` and `[subject]` inside a rule's reply.

Literal braces and brackets are escaped with a backslash: `\{`, `\[`.

The composer shows the **exact** size of the pool — not an estimate — so a
template that looks varied but only has two real variations cannot pretend
otherwise. Draws rotate rather than repeat: a bucket is shuffled and consumed
before it refills, so two consecutive posts rarely reuse a keyword.

**Generate variations** spins a pool of up to thirty and offers to drip them
across a schedule.

---

## Posting to many accounts at once

Select any set of accounts across any set of profiles and send. Per network the
composer shows the rendered text, the character count against that network's real
limit (X counts a URL as 23 characters; Bluesky counts graphemes), the part that
would be cut off, and anything that would block the send — Instagram without an
image, a Telegram account with no chat id, a disconnected account.

**Spin a different version for each account** is on by default. The same idea
posted twelve different ways is a campaign; the identical string on twelve
accounts is a fingerprint.

A fan-out never collapses into one result. Nine accounts accepting and one
rejecting is nine successes and one failure, recorded per account, because that
is what you have to act on.

---

## Scheduling

Two ways to lay posts on a calendar:

- **Fixed times** — "09:15, 13:40 and 17:20, Mon–Fri", with a scatter of ±N
  minutes so it is not metronomic.
- **Every so often** — "every 45 to 120 minutes between 09:00 and 21:00", which
  is what a drip campaign wants.

**Generate & drip** combines the two: spin a pool of messages, lay them across a
schedule, one per slot. Either every selected account gets every post, or the
pool is spread across the accounts.

Two things send, and never the same post twice:

| | The app | The relay |
| --- | --- | --- |
| Sends | while Broadcast Desk runs — the tray keeps it running after you close the window | on a cron, with the machine off |
| Which posts | accounts **not** marked Unattended | accounts marked **Unattended** |
| Media | straight off your disk | whatever was uploaded with the post |

The Queue screen says which half is where. The sidebar badge says whether the
desk is in dry run, live, or live with a relay attached — and a post is never
recorded as sent when it was simulated.

### What a post costs

X is the only network here that charges: $0.015 a post, or **$0.20 if the post
contains a link**. The composer prices a send before you make it, Settings holds
a monthly cap checked before the request goes out, and link-bearing posts to X
are refused unless you allow the charge on that specific post.

---

## Rules

A rule is: *when X shows up on these accounts, do Y, no more than this often.*

**Triggers** — a mention, a reply, a keyword or hashtag match, a new follower,
a direct message.

**Filters** — exclusion terms, a minimum follower count, verified only, a
language, ignore reposts, ignore replies.

**Actions** — reply, quote, repost, like, post, DM. The message comes from a
saved template, from library entries by tag, or from text written into the rule
— and it goes through the same generator, so automated replies vary too.

**Caps** — per hour, per day, a minimum gap, a maximum per author, active hours
and days.

Underneath the builder is a sentence that updates as you type:

> On **@rulloenterprises**, when a post matches any of these terms `top-up`,
> `airtime`, `gift card`, reply to it using **Mention — friendly reply**.
> Filters: skip anything containing `free followers`, `crypto`; ignore reposts.
> Capped at `6/hour`, `40/day`, at least `5 min` apart, `1×` per author, only
> between `08:00` and `22:00`. Actions wait in the inbox for your approval
> before they go out.

If that sentence does not read like what you meant, it is not what you meant.
**Test it** runs the rule against the current inbox (or sample items) and shows
what it would do and what the caps would hold back — without sending anything.

### Approval, and why it is the default

Rules stage their actions in the **Inbox** for a yes or no rather than firing
them at the network. You can edit the drafted reply, re-spin it, approve one, or
approve the lot.

Turning approval off is one checkbox, and there are rules where that is right —
but the default is on, because:

- Every network's automation policy is written in terms of volume and
  repetition. Bulk identical replies and mass reposting are what get accounts
  limited.
- A rule that matches more than you expected is discovered in the inbox, not in
  a suspension email.
- On a client's account, the asset at risk is theirs.

The relay enforces its own ceilings on top of whatever a rule says, and the app
checks the spend cap before any request leaves — a rule cannot spend past it.

---

## Data, and where it lives

Everything you create — profiles, accounts, library, templates, queue, rules —
lives on this machine, in the app's data folder (**File → Reveal data folder**).
Nothing is uploaded anywhere except what a post needs in order to be published.

No credential is ever written to that workspace database. Account rows hold a
label and an opaque connection id; the tokens sit in the vault, encrypted by the
OS keyring, and a copy reaches the relay only for accounts you switched to
Unattended.

**Settings → Data** exports the whole workspace as JSON and imports it back,
which is how you move between machines. Deleting the data folder deletes the
desk, so keep an export.

---

## Getting going

1. **Profiles** — one per identity. Delete the seeded examples.
2. **Library** — bulk-add your keywords and phrases and tag them. This is what
   the generator has to work with; a thin library makes thin variations.
3. **Compose** — write a template, watch the variation count, check the previews,
   save it as a template.
4. **Connections** — add accounts and connect them. The first real connection
   turns dry run off.
5. **Rules** — one at a time, tested, with approval on.

Steps 1–3 need no credentials at all. Per-network credentials are in
[SETUP.md](SETUP.md).
