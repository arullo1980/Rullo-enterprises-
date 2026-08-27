/* Rullo Enterprises — front-end configuration.

   apiBase is the URL of the Reloadly proxy Worker (workers/reloadly-proxy).
   Leave it empty and the site behaves exactly as it does today: the coverage
   explorer confirms a destination is reachable and hands off to the checkout
   widget. Set it, and the explorer additionally shows the real operators,
   gift card brands, and billers for the selected country.

   The site is designed to work either way — if the proxy is unset, slow, or
   down, nothing breaks and nothing looks broken.

   To turn live coverage on:
     1. Deploy the Worker   (see workers/reloadly-proxy/README.md)
     2. Put its URL here    e.g. "https://rullo-reloadly-proxy.<you>.workers.dev"
     3. Commit and push — GitHub Pages redeploys automatically.

   This file holds no secrets. The credentials live only in Cloudflare; this
   URL is public by design. */
window.RULLO_CONFIG = {
  apiBase: "",
};
