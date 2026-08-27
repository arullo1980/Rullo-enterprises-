# Reloadly proxy (Cloudflare Worker)

A small server-side proxy that holds the Reloadly API credentials and exposes
read-only endpoints the static storefront can call. **The browser never sees
the credentials** — it only ever calls this Worker.

Why it exists: the site is static (GitHub Pages), so a secret can't live in
the page. This Worker is the secure place to keep it.

Reloadly is really three APIs behind one set of credentials — top-ups, gift
cards, and utilities — each with its own host, its own OAuth `audience`, and
its own `Accept` version. The Worker hides that: the site asks for a country
and gets back everything available there.

## Endpoints

All GET, all read-only. Nothing here can spend money.

| Path | Returns |
| --- | --- |
| `/coverage?country=NG` | airtime, data, gift cards and bills for one country, in a single call |
| `/operators?country=NG` | mobile airtime + data operators |
| `/giftcards?country=NG` | gift card brands |
| `/utilities?country=NG` | electricity / water / TV billers |
| `/countries` | every destination Reloadly can reach |
| `/health` | `{ ok, mode, credentials }` |

`/coverage` is the one the site actually uses. It fans out to all three APIs
at once and degrades per-category: if the account isn't enabled for gift
cards, that category comes back `available: false` and the rest still work.

CORS is locked to `rulloenterprises.com` and `www.`. Add more origins with the
`ALLOWED_ORIGINS` var in `wrangler.toml` rather than editing the code.

## Running it locally — no Reloadly account needed

Credentials haven't been issued yet, so the Worker ships with a **mock mode**
that serves fixture data in exactly the shape the real API returns. This is how
the storefront was wired up and tested before any account existed.

```bash
cd workers/reloadly-proxy
npm install
npm test          # 18 offline tests: routing, validation, CORS, caching
npm run dev:mock  # a local Worker on fixture data
```

Point `site/js/config.js` at `http://localhost:8787` and the coverage explorer
will show the fixture operators. **Never deploy in mock mode.**

## Deploy (you do this — I never see the secret)

Prereqs: a Cloudflare account (you have one) and Node installed.

```bash
cd workers/reloadly-proxy
npm install
npx wrangler login                       # opens Cloudflare to authorize

# Store the credentials as ENCRYPTED secrets (paste when prompted).
# These live in Cloudflare only — never in this repo or in chat.
npx wrangler secret put RELOADLY_CLIENT_ID
npx wrangler secret put RELOADLY_CLIENT_SECRET

npm run deploy
```

After deploy you'll get a URL like `https://rullo-reloadly-proxy.<you>.workers.dev`.
Smoke-test it end to end:

```bash
./test.sh https://rullo-reloadly-proxy.<you>.workers.dev
```

That checks every endpoint, confirms a bad country code is rejected, and
confirms an untrusted origin is refused.

## Turning on live coverage

Once the Worker is deployed and `test.sh` passes, put its URL into
`site/js/config.js`:

```js
window.RULLO_CONFIG = {
  apiBase: "https://rullo-reloadly-proxy.<you>.workers.dev",
};
```

Commit and push — GitHub Pages redeploys itself. The coverage explorer will
start showing the real operators, brands, and billers per country.

Leave `apiBase` empty and the site behaves exactly as it does today. The
front end treats live data as strictly additive: if the proxy is unset, slow,
or down, the panel keeps its offline content and nothing looks broken.

## Sandbox vs live

`wrangler.toml` sets `RELOADLY_ENV = "sandbox"` so you can test safely with no
real money. Switch to `"live"` (and redeploy) once verified — and make sure
your Reloadly credentials match the mode (sandbox and live have separate keys).

`/health` reports which mode is running and whether credentials are present,
so you can always confirm what a deployed Worker is actually doing.

## Optional: serve from `api.rulloenterprises.com`

Uncomment the `[[routes]]` block in `wrangler.toml`. This adds only the `api`
subdomain to Cloudflare — it does **not** affect the apex records pointing at
GitHub Pages, so the website keeps working exactly as-is.

## What's next

The larger follow-on is a fully custom checkout (operator → amount →
recipient → pay via Stripe → order via Reloadly's API), which removes the
embedded widget entirely. That needs write access to the Reloadly API and a
Stripe integration, so it is deliberately out of scope here — every endpoint
in this Worker is read-only by design.
