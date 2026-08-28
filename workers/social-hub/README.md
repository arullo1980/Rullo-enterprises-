# social-hub — the Broadcast Desk backend

The console at `/app` is a static page. It can hold a plan; it must not hold a
credential. This Worker is the other half: it runs the OAuth flows, keeps every
token encrypted in KV, fans a post out across networks, and drains the schedule
on a cron so queued posts go out with nothing open.

Without it the desk still runs — profiles, library, generator, queue and rules
all work — but every send is a dry run.

## Deploy

```sh
cd workers/social-hub

# 1. Storage for connections and the queue.
npx wrangler kv namespace create HUB
#    Put the printed id into wrangler.toml under [[kv_namespaces]].

# 2. Set PUBLIC_URL in wrangler.toml to this Worker's own URL, then deploy once
#    so the URL exists.
npx wrangler deploy

# 3. Secrets. DESK_KEY is what the console sends; TOKEN_KEY encrypts tokens at
#    rest. Generate both with something like:
#      node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
npx wrangler secret put DESK_KEY
npx wrangler secret put TOKEN_KEY

# 4. One pair per network you intend to post to.
npx wrangler secret put X_CLIENT_ID
npx wrangler secret put X_CLIENT_SECRET
#   …and the same for MASTODON_, LINKEDIN_, FACEBOOK_, INSTAGRAM_, THREADS_,
#   REDDIT_, TUMBLR_, PINTEREST_, TIKTOK_, YOUTUBE_

npx wrangler deploy
```

Then open the desk → **Settings → Backend**, enter the Worker URL and the
`DESK_KEY`, and press **Test connection**. The badge in the sidebar goes from
`dry run` to `live`.

## Registering the developer apps

Each network wants a redirect URI registered before it will hand over a token.
For every one of them it is the same value:

```
<PUBLIC_URL>/oauth/callback
```

It must match character for character, including the scheme and any trailing
path. A mismatch is the single most common reason a connection fails.

| Network | Where to register | Notes |
| --- | --- | --- |
| X | developer.x.com | Write access needs a paid tier. |
| Mastodon | your instance's Development page | Each instance is its own OAuth server. |
| LinkedIn | developer.linkedin.com | `w_member_social` needs the Share on LinkedIn product. |
| Facebook / Instagram / Threads | developers.facebook.com | Pages and Business accounts only. |
| Reddit | reddit.com/prefs/apps | Type "web app". Set a descriptive `USER_AGENT`. |
| Pinterest, TikTok, YouTube, Tumblr | each network's developer portal | Configured, but the publish adapters are not wired yet — see below. |

Bluesky, Telegram and Discord do not use OAuth. They are connected by pasting a
credential the user generates themselves: a Bluesky **app password** (never the
account password), a bot token from **@BotFather**, or a channel **webhook URL**.
Those go straight to this Worker and are never written to the browser database.

## What is implemented

| Network | Post | Reply | Repost | Like | Feed |
| --- | --- | --- | --- | --- | --- |
| X | ✅ | ✅ | ✅ | ✅ | ✅ mentions |
| Bluesky | ✅ | ✅ | ✅ | ✅ | ✅ mentions, replies |
| Mastodon | ✅ | ✅ | ✅ | ✅ | ✅ mentions |
| LinkedIn | ✅ | — | — | — | — |
| Facebook Page | ✅ | ✅ | — | — | — |
| Instagram | ✅ (needs media) | — | — | — | — |
| Threads | ✅ | — | — | — | — |
| Reddit | ✅ | ✅ | — | — | — |
| Telegram | ✅ | ✅ | — | — | — |
| Discord | ✅ | — | — | — | — |
| TikTok, YouTube, Pinterest, Tumblr | not wired | | | | |

The four unwired ones each need something a fan-out call cannot do sensibly —
chunked video upload, a resumable transfer, a per-account board id. They are
declared in the catalogue and return a clear error rather than failing silently,
so nothing looks connected when it is not.

## Safety rails

These are enforced here, not in the browser, because the browser is the part a
misconfiguration or a bug lives in.

- **Rate ceilings.** `MAX_POSTS_PER_HOUR` and `MAX_ACTIONS_PER_HOUR` are per
  connection and apply no matter what the console asks for.
- **Spaced fan-out.** `FANOUT_GAP_MS` between accounts. Twelve identical posts
  in the same second is the exact signature the networks score as automation.
- **Encrypted at rest.** Tokens are AES-GCM sealed under `TOKEN_KEY`; a KV dump
  on its own is not a set of live credentials.
- **Delete-then-send.** The cron removes a queue entry before publishing it, so
  a failure is recorded as failed rather than retried into a double post.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness and connection count |
| POST | `/connect/start` | Begin an OAuth flow, returns the authorisation URL |
| GET | `/oauth/callback` | Where the network redirects back |
| POST | `/connect/token` | Store a pasted credential (Bluesky, Telegram, Discord) |
| GET | `/connections` | List connected accounts (metadata only, never tokens) |
| DELETE | `/connections/:id` | Disconnect |
| POST | `/publish` | Fan a post out, returns one result per account |
| POST | `/act` | Carry out a rule action (reply, repost, like) |
| POST | `/feed` | Mentions and replies for the rules to run against |
| POST | `/queue/sync` | Hand the schedule over for unattended sending |
| POST | `/queue/results` | Collect what the cron sent |

Everything except `/health` and `/oauth/callback` requires
`Authorization: Bearer <DESK_KEY>`.

## Tests

```sh
node workers/social-hub/test.mjs
```

Runs the Worker against an in-memory KV with the outbound network stubbed —
no wrangler, no dependencies, no live calls. It covers the things that are
expensive to get wrong: tokens unreadable at rest, the desk key actually
required, PKCE where it should be, per-account fan-out results, the cron
sending only what is due and never twice, and the hourly ceiling holding.

## Local development

```sh
npx wrangler dev
```

`PUBLIC_URL` must point at something the networks can reach, so OAuth flows
cannot be completed against `localhost`. Connect the paste-a-credential networks
locally, and test the OAuth ones against a deployed Worker.
