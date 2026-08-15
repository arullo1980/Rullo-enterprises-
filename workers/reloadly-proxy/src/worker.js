/**
 * Rullo Enterprises — Reloadly API proxy (Cloudflare Worker)
 *
 * The storefront is a static site, so it cannot safely hold the Reloadly
 * credentials. This tiny Worker holds them server-side (as encrypted
 * Cloudflare secrets) and exposes read-only endpoints the site can call.
 * The browser never sees the secret; it only ever talks to this Worker.
 *
 * Secrets (set once in Cloudflare, never committed):
 *   RELOADLY_CLIENT_ID
 *   RELOADLY_CLIENT_SECRET
 * Optional var:
 *   RELOADLY_ENV = "live" (default) | "sandbox"
 *
 * Endpoints:
 *   GET /operators?country=NG   -> operators available in a country
 *   GET /health                 -> { ok: true }
 */

const ALLOWED_ORIGINS = [
  "https://rulloenterprises.com",
  "https://www.rulloenterprises.com",
];

// Simple in-isolate token cache (Workers reuse isolates between requests).
let tokenCache = { token: null, expiresAt: 0 };

function endpoints(env) {
  var sandbox = (env.RELOADLY_ENV || "live").toLowerCase() === "sandbox";
  var base = sandbox
    ? "https://topups-sandbox.reloadly.com"
    : "https://topups.reloadly.com";
  return { audience: base, api: base };
}

function corsHeaders(origin) {
  var allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({}, headers, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    }),
  });
}

async function getToken(env) {
  var now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60000) return tokenCache.token;

  var res = await fetch("https://auth.reloadly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.RELOADLY_CLIENT_ID,
      client_secret: env.RELOADLY_CLIENT_SECRET,
      grant_type: "client_credentials",
      audience: endpoints(env).audience,
    }),
  });
  if (!res.ok) throw new Error("auth " + res.status);
  var data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function operatorsByCountry(env, iso) {
  var token = await getToken(env);
  var res = await fetch(endpoints(env).api + "/operators/countries/" + encodeURIComponent(iso), {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/com.reloadly.topups-v1+json",
    },
  });
  if (!res.ok) throw new Error("operators " + res.status);
  var list = await res.json();
  if (!Array.isArray(list)) list = [];
  // Return only what the UI needs — nothing sensitive.
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

export default {
  async fetch(request, env) {
    var origin = request.headers.get("Origin") || "";
    var headers = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { headers: headers });

    var url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true }, 200, headers);

      if (url.pathname === "/operators") {
        var iso = (url.searchParams.get("country") || "").toUpperCase().slice(0, 2);
        if (!/^[A-Z]{2}$/.test(iso)) {
          return json({ error: "country must be a 2-letter ISO code" }, 400, headers);
        }
        var operators = await operatorsByCountry(env, iso);
        return json({ country: iso, count: operators.length, operators: operators }, 200, headers);
      }

      return json({ error: "not found" }, 404, headers);
    } catch (e) {
      // Never leak upstream error detail to the browser.
      return json({ error: "upstream error" }, 502, headers);
    }
  },
};
