# The relay

Broadcast Desk is a desktop app: it holds its own credentials and posts by
itself. This Worker exists for the three things a program on your desk cannot
do, and nothing else:

1. **Take the OAuth callback** for networks that refuse a `127.0.0.1` redirect —
   Meta, TikTok, Pinterest, LinkedIn.
2. **Host media at a public URL** for networks that fetch the file themselves
   rather than accepting an upload — Instagram, and Reddit link posts.
3. **Send scheduled posts while the machine is off**, for accounts the operator
   marked *Unattended*.

Without it the desk still does everything else: X, Reddit, Tumblr, Vimeo,
Telegram, Discord, WordPress, Bluesky and Mastodon all connect and post
straight from the app, and scheduled posts go out while it is running.

## Deploy

```sh
cd broadcast-desk/worker

# 1. Storage for connections and the queue, and a bucket for media.
npx wrangler kv namespace create HUB
#    Put the printed id into wrangler.toml under [[kv_namespaces]].
npx wrangler r2 bucket create broadcast-desk-media

# 2. Set PUBLIC_URL in wrangler.toml to this Worker's own URL, then deploy once
#    so the URL exists.
npx wrangler deploy

# 3. Secrets. DESK_KEY is what the console sends; TOKEN_KEY encrypts tokens at
#    rest. Generate both with something like:
#      node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
npx wrangler secret put DESK_KEY
npx wrangler secret put TOKEN_KEY

# 4. One pair per network you intend to post to.
npx wrangler secret put FACEBOOK_CLIENT_ID
npx wrangler secret put FACEBOOK_CLIENT_SECRET
#   …and the same for INSTAGRAM_, TIKTOK_, PINTEREST_, LINKEDIN_ — the networks
#   whose callback the relay takes. Add X_, REDDIT_, TUMBLR_, VIMEO_ as well if
#   you want those accounts to post unattended too.

npx wrangler deploy
```

Then in the app → **Settings → Relay**, enter the Worker URL and the `DESK_KEY`,
and press **Test**. The sidebar badge changes to `live + relay`.

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

## Adapters

The relay shares `shared/adapters.js` with the app, so every network the desk can
post to, the cron can post to as well. See the product README for the table.

Mention collection (`/feed`, which the rules run against) is implemented for X,
Mastodon and Bluesky — the networks with a usable read API on the token the desk
already holds. The others return nothing rather than pretending: a rule that
silently never fires is worse than one that says why.

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
| POST | `/connect/pickup` | The app collects a connection the relay authorised |
| POST | `/connections/store` | The app pushes a token for unattended sending |
| POST | `/media/slot` | Get a short-lived upload + public URL for one file |
| GET | `/media/:key` | Serve it — public, because Instagram fetches it itself |
| POST | `/publish` | Fan a post out, returns one result per account |
| POST | `/act` | Carry out a rule action (reply, repost, like) |
| POST | `/feed` | Mentions and replies for the rules to run against |
| POST | `/queue/sync` | Hand the schedule over for unattended sending |
| POST | `/queue/results` | Collect what the cron sent |

Everything except `/health` and `/oauth/callback` requires
`Authorization: Bearer <DESK_KEY>`.

## Tests

```sh
node worker/test.mjs
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
