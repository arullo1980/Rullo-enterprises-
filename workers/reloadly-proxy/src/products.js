/**
 * Reloadly product definitions.
 *
 * Reloadly is three separate APIs behind one set of credentials. Each has its
 * own host, its own OAuth `audience`, and its own versioned Accept header —
 * a token minted for one is NOT valid for the others.
 *
 *   topups     mobile airtime + data bundles
 *   giftcards  gift card brands
 *   utilities  electricity / water / TV bill payments
 */

export var PRODUCTS = {
  topups: {
    host: { live: "https://topups.reloadly.com", sandbox: "https://topups-sandbox.reloadly.com" },
    accept: "application/com.reloadly.topups-v1+json",
  },
  giftcards: {
    host: { live: "https://giftcards.reloadly.com", sandbox: "https://giftcards-sandbox.reloadly.com" },
    accept: "application/com.reloadly.giftcards-v1+json",
  },
  utilities: {
    // The utilities API is not versioned via Accept; it takes plain JSON.
    host: { live: "https://utilities.reloadly.com", sandbox: "https://utilities-sandbox.reloadly.com" },
    accept: "application/json",
  },
};

/** Base URL for a product in the current environment. Also the OAuth audience. */
export function hostFor(product, env) {
  var mode = (env.RELOADLY_ENV || "live").toLowerCase();
  var hosts = PRODUCTS[product].host;
  return mode === "sandbox" ? hosts.sandbox : hosts.live;
}

/**
 * Reloadly returns bare arrays from some endpoints and Spring-style paginated
 * objects (`{ content: [...] }`) from others, and has changed which is which
 * between versions. Normalise both.
 */
export function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.content)) return payload.content;
  return [];
}
