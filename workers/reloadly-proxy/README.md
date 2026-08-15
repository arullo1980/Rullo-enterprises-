# Reloadly proxy (Cloudflare Worker)

A tiny server-side proxy that holds the Reloadly API credentials and exposes
read-only endpoints the static storefront can call. **The browser never sees
the credentials** — it only ever calls this Worker.

Why it exists: the site is static (GitHub Pages), so a secret can't live in
the page. This Worker is the secure place to keep it.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/operators?country=NG` | operators available in that country (2-letter ISO) |
| GET | `/health` | `{ ok: true }` |

CORS is locked to `rulloenterprises.com` (and `www`).

## Deploy (you do this — I never see the secret)

Prereqs: a Cloudflare account (you have one) and Node installed.

```bash
cd workers/reloadly-proxy
npx wrangler login                       # opens Cloudflare to authorize

# Store the credentials as ENCRYPTED secrets (paste when prompted).
# These live in Cloudflare only — never in this repo or in chat.
npx wrangler secret put RELOADLY_CLIENT_ID
npx wrangler secret put RELOADLY_CLIENT_SECRET

npx wrangler deploy                       # deploys the Worker
```

After deploy you'll get a URL like `https://rullo-reloadly-proxy.<you>.workers.dev`.
Test it:

```bash
curl "https://rullo-reloadly-proxy.<you>.workers.dev/health"
curl "https://rullo-reloadly-proxy.<you>.workers.dev/operators?country=NG"
```

## Sandbox vs live

`wrangler.toml` sets `RELOADLY_ENV = "sandbox"` so you can test safely with no
real money. Switch to `"live"` (and redeploy) once verified — and make sure
your Reloadly credentials match the mode (sandbox and live have separate keys).

## Optional: serve from `api.rulloenterprises.com`

Uncomment the `[[routes]]` block in `wrangler.toml`. This adds only the `api`
subdomain to Cloudflare — it does **not** affect the apex records pointing at
GitHub Pages, so the website keeps working exactly as-is.

## What's next

Once this is live, the storefront's coverage explorer will call
`/operators?country=XX` to show the **real** operators per country. The larger
follow-on is a fully custom checkout (operator → amount → recipient → pay via
Stripe → order via Reloadly's API), which removes the embedded widget entirely.
