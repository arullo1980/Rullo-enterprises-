# Rullo-enterprises-

Guidance for Claude Code working in this repository.

<!-- PROJECT-BRIEF:BEGIN -->
## Project brief

Two things live in this repo:

1. **Reloadly storefront for rulloenterprises.com** - airtime top-ups, data
   bundles, gift cards, utility bill payments, worldwide.
2. **Broadcast Desk** (`site/app/`) - a multi-account social operations console
   (PWA) with a message generator, simultaneous posting, scheduling and an
   ad-hoc rule engine. Backend is `workers/social-hub`. See
   `docs/BROADCAST_DESK.md`.

- **Stack:** plain static HTML/CSS/JS. No build step, no framework, no
  dependencies - keep it that way. Cloudflare Workers for anything that needs a
  secret: `workers/reloadly-proxy` (PR #5) and `workers/social-hub`.
- **State:** storefront built and rendering locally, **not yet live**. The
  console is built and tested; it runs in dry run until the Worker is deployed.

**Broadcast Desk invariants** - do not regress these:
- Never store a social credential in the browser. Tokens live in the Worker,
  encrypted; account rows hold only an opaque connection id.
- Client accounts are connected by the client authorising the app, never by
  collecting their password.
- Never report a post as sent when it was simulated.

**Current priority: integration.**

**Open items**
1. Enable GitHub Pages (Settings > Pages > Source = GitHub Actions); the
   `deploy.yml` workflow publishes `site/`.
2. The privacy policy in `site/privacy/` is a **DRAFT** and must be finished
   before launch.
3. Wire up the secure Reloadly API proxy scaffold added in PR #5.
4. Checkout runs inside Reloadly's embedded Plugin V2 widget, so this codebase
   never sees payment data. Widget behavior/theme is configured in the Reloadly
   dashboard, not here. Deeper API integration needs credentials that have not
   been issued yet.
5. Full context in `CLAUDE_CODE_HANDOFF.md`.
<!-- PROJECT-BRIEF:END -->

---

<!-- SHARED-PROTOCOL:BEGIN -->
## Multi-machine work protocol (mandatory)

This repository is worked on by **more than one machine**. Follow this protocol
on every session, without exception. Its single purpose is that **no machine
ever undoes another machine's work.**

### The governing rule

**GitHub is the master.** At the start of any work session, the version on
GitHub is authoritative — not the local working copy, no matter how recent it
looks or who last touched it. Local work that conflicts with GitHub is the
local copy's problem to resolve, never GitHub's.

### Session order

**1. Check before anything else.**

```
python _toolkit/postmark.py check
```

This fetches from origin and reports whether the local copy matches GitHub,
plus which machine touched this repository last and what it did. Do not read,
reason about, or edit a single file until this prints `SAFE TO WORK`.

If it reports `NOT SAFE TO WORK`:

- **behind origin** — `git pull --rebase` and check again.
- **uncommitted changes** — these are from a previous session that failed to
  finish. Read them, then commit or stash them. Never discard without looking.
- **no upstream** — push the branch before continuing.

If the postmark shows another machine touched this repository more recently
than your last row, **read that machine's commits before writing anything**
(`git log --oneline <your-last-commit>..HEAD`). Assume its work is correct and
build on it.

**2. Branch, then modify.**

Never commit directly to `main`. Work on a branch namespaced to this machine so
two machines can never contend for the same ref:

```
git checkout -b <machine>/<topic>
```

Open the pull request early, as a draft. An open draft PR is the signal to the
other machine that this repository is actively being worked on.

**3. Push, postmark, and update the README.**

Before the final push of a session:

```
python _toolkit/postmark.py stamp -m "one line describing what changed"
git add -A && git commit -m "..." && git push
```

The stamp writes this machine's row into the README postmark table: machine
name, UTC timestamp, branch, commit, and summary. This is how the other machine
knows what happened here and when. A session that ends without a postmark is an
incomplete session.

### Machine registry

Exactly two machines work these repositories. Each sets `POSTMARK_MACHINE` to
its own name; the hostname is used if unset. **The two names must never
collide, and a machine must never stamp under the other machine's name.**

| Name           | Which machine                                    |
| -------------- | ------------------------------------------------ |
| `Antonio`      | Primary workstation (Windows). Node, Python, pnpm, pytest, GitHub CLI. No Delphi. |
| `RulloFamily`  | Second machine.                                  |

Set it once per machine:

```
setx POSTMARK_MACHINE "Antonio"        # Windows
export POSTMARK_MACHINE="RulloFamily"  # macOS/Linux, add to your shell profile
```

Branch names follow the machine: `antonio/<topic>` and `rullofamily/<topic>`.
A machine never pushes to a branch namespaced to the other.

### What never happens

- Never force-push a shared branch.
- Never delete or rewrite another machine's postmark row.
- Never resolve a conflict by taking the local side wholesale — read both.
- Never start work on a repository whose check has not passed.
<!-- SHARED-PROTOCOL:END -->
