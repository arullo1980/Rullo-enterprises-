/**
 * Rullo Enterprises — Reloadly API proxy (Cloudflare Worker)
 *
 * The storefront is a static site, so it cannot safely hold the Reloadly
 * credentials. This Worker holds them server-side (as encrypted Cloudflare
 * secrets) and exposes read-only endpoints the site can call. The browser
 * never sees the secret; it only ever talks to this Worker.
 *
 * Secrets (set once in Cloudflare, never committed):
 *   RELOADLY_CLIENT_ID
 *   RELOADLY_CLIENT_SECRET
 * Vars:
 *   RELOADLY_ENV     = "live" (default) | "sandbox" | "mock"
 *   ALLOWED_ORIGINS  = optional comma-separated extra origins
 *
 * Endpoints (all GET, all read-only — nothing here can spend money):
 *   /health                  service + mode
 *   /countries               destinations Reloadly can reach
 *   /operators?country=NG    mobile airtime + data operators
 *   /giftcards?country=NG    gift card brands
 *   /utilities?country=NG    electricity / water / TV billers
 *   /coverage?country=NG     all three at once, for the coverage explorer
 */

import { PRODUCTS, hostFor, asList } from "./products.js";
import { isMock, mockData } from "./mock.js";

var ALLOWED_ORIGINS = [
  "https://rulloenterprises.com",
  "https://www.rulloenterprises.com",
];

var UPSTREAM_TIMEOUT_MS = 8000;
var SUCCESS_CACHE = "public, max-age=3600";

// Token cache, keyed by audience — a token minted for topups is not valid for
// giftcards, so a single shared slot would hand the wrong token to two of the
// three APIs. Workers reuse isolates between requests, so this survives.
var tokenCache = new Map();

function allowedOrigins(env) {
  var extra = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  return ALLOWED_ORIGINS.concat(extra);
}

/**
 * Only echo an origin we actually trust. An unknown origin gets no
 * Access-Control-Allow-Origin at all, which is what makes the browser block
 * it — echoing the canonical origin instead would be a silent no-op.
 * Non-browser callers (curl, the test script) send no Origin and are fine.
 */
function corsHeaders(request, env) {
  var origin = request.headers.get("Origin") || "";
  var headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins(env).indexOf(origin) !== -1) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Errors are never cached — a cached 502 would outlive the outage that caused it. */
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({}, headers, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status >= 400 ? "no-store" : SUCCESS_CACHE,
    }),
  });
}

/**
 * Exactly two letters, or nothing. Truncating instead would turn a typo like
 * "ZZZ" into a different, valid-looking country and answer for the wrong one.
 */
function countryParam(url) {
  var iso = (url.searchParams.get("country") || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(iso) ? iso : null;
}

async function getToken(env, audience) {
  var now = Date.now();
  var cached = tokenCache.get(audience);
  if (cached && now < cached.expiresAt - 60000) return cached.token;

  if (!env.RELOADLY_CLIENT_ID || !env.RELOADLY_CLIENT_SECRET) {
    throw new Error("credentials not configured");
  }

  var res = await fetch("https://auth.reloadly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.RELOADLY_CLIENT_ID,
      client_secret: env.RELOADLY_CLIENT_SECRET,
      grant_type: "client_credentials",
      audience: audience,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("auth " + res.status);

  var data = await res.json();
  tokenCache.set(audience, {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

async function callReloadly(env, product, path) {
  var host = hostFor(product, env);
  var token = await getToken(env, host);
  var res = await fetch(host + path, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: PRODUCTS[product].accept,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(product + " " + res.status);
  return asList(await res.json());
}

/* --- Shaping: return only what the UI needs, never raw upstream payloads. --- */

function shapeOperators(list) {
  return list.map(function (o) {
    return {
      id: o.operatorId,
      name: o.name,
      bundle: !!o.bundle,
      data: !!o.data,
      type: o.denominationType,
      logo: (o.logoUrls && o.logoUrls[0]) || null,
    };
  });
}

function shapeGiftcards(list) {
  return list.map(function (p) {
    return {
      id: p.productId,
      name: p.productName,
      brand: (p.brand && p.brand.brandName) || null,
      currency: p.recipientCurrencyCode || null,
      logo: (p.logoUrls && p.logoUrls[0]) || null,
    };
  });
}

function shapeUtilities(list) {
  return list.map(function (b) {
    return { id: b.id, name: b.name, type: b.type, serviceType: b.serviceType };
  });
}

function shapeCountries(list) {
  return list.map(function (c) {
    return { iso: c.isoName, name: c.name, currency: c.currencyCode };
  });
}

var CATALOG = {
  operators: {
    product: "topups",
    path: function (iso) { return "/operators/countries/" + iso; },
    shape: shapeOperators,
    mock: "topups",
  },
  giftcards: {
    product: "giftcards",
    path: function (iso) { return "/countries/" + iso + "/products"; },
    shape: shapeGiftcards,
    mock: "giftcards",
  },
  utilities: {
    product: "utilities",
    path: function (iso) { return "/billers?countryISOCode=" + iso + "&size=200"; },
    shape: shapeUtilities,
    mock: "utilities",
  },
};

async function fetchCategory(env, key, iso) {
  var spec = CATALOG[key];
  if (isMock(env)) return mockData(spec.mock, iso);
  return spec.shape(await callReloadly(env, spec.product, spec.path(iso)));
}

async function fetchCountries(env) {
  if (isMock(env)) return mockData("countries");
  return shapeCountries(await callReloadly(env, "topups", "/countries"));
}

function summarise(available, items) {
  return {
    available: available,
    count: items.length,
    sample: items.slice(0, 6).map(function (x) { return x.name; }),
  };
}

/**
 * One round trip for the coverage explorer. Uses allSettled so a category the
 * account has not been enabled for (a 403) degrades to `available: false`
 * instead of failing the whole request.
 */
async function fetchCoverage(env, iso) {
  var keys = Object.keys(CATALOG);
  var settled = await Promise.allSettled(
    keys.map(function (key) { return fetchCategory(env, key, iso); })
  );

  var byKey = {};
  var reachable = false;
  settled.forEach(function (result, i) {
    var ok = result.status === "fulfilled";
    var items = ok ? result.value : [];
    if (ok && items.length) reachable = true;
    byKey[keys[i]] = { ok: ok, items: items };
  });

  // Airtime and data bundles arrive in the same operators call but are sold as
  // separate things on the storefront, so they are reported separately —
  // otherwise a country with one data plan would advertise every operator as
  // offering data.
  var ops = byKey.operators;
  var airtime = ops.items.filter(function (o) { return !o.data; });
  var data = ops.items.filter(function (o) { return !!o.data; });

  return {
    country: iso,
    reachable: reachable,
    categories: {
      operators: summarise(ops.ok, airtime),
      data: summarise(ops.ok, data),
      giftcards: summarise(byKey.giftcards.ok, byKey.giftcards.items),
      utilities: summarise(byKey.utilities.ok, byKey.utilities.items),
    },
  };
}

export default {
  async fetch(request, env) {
    var headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405, headers);
    }

    var url = new URL(request.url);
    var path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health") {
        return json({
          ok: true,
          mode: (env.RELOADLY_ENV || "live").toLowerCase(),
          credentials: !!(env.RELOADLY_CLIENT_ID && env.RELOADLY_CLIENT_SECRET),
        }, 200, headers);
      }

      if (path === "/countries") {
        var countries = await fetchCountries(env);
        return json({ count: countries.length, countries: countries }, 200, headers);
      }

      if (path === "/coverage" || CATALOG[path.slice(1)]) {
        var iso = countryParam(url);
        if (!iso) {
          return json({ error: "country must be a 2-letter ISO code" }, 400, headers);
        }
        if (path === "/coverage") {
          return json(await fetchCoverage(env, iso), 200, headers);
        }
        var key = path.slice(1);
        var items = await fetchCategory(env, key, iso);
        var body = { country: iso, count: items.length };
        body[key] = items;
        return json(body, 200, headers);
      }

      return json({ error: "not found" }, 404, headers);
    } catch (e) {
      // Never leak upstream error detail to the browser.
      var missing = String(e && e.message) === "credentials not configured";
      return json(
        { error: missing ? "proxy not configured" : "upstream error" },
        missing ? 503 : 502,
        headers
      );
    }
  },
};
