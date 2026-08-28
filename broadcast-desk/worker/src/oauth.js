/**
 * The relay's half of the OAuth flow.
 *
 * Only used by networks that refuse a loopback redirect — Meta, TikTok,
 * Pinterest, LinkedIn. The desktop app starts the flow here, the operator
 * approves on the network's own page, the network redirects back to this
 * Worker over HTTPS, and the app collects the finished connection.
 *
 * Endpoint configuration is shared with the app so both sides build the same
 * URL. A redirect_uri that differs by one character fails confusingly.
 */

import { id, KEY, saveConnection, nowIso, seal } from "./lib.js";
import { PROVIDERS, endpointsFor, authorizeUrl, tokenRequest } from "../../shared/providers.js";

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function credentials(env, platform) {
  const up = platform.toUpperCase();
  return { clientId: env[`${up}_CLIENT_ID`], clientSecret: env[`${up}_CLIENT_SECRET`] };
}

export function callbackUrl(env) {
  if (!env.PUBLIC_URL) throw new Error("PUBLIC_URL is not set on the Worker.");
  return `${env.PUBLIC_URL.replace(/\/+$/, "")}/oauth/callback`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return data;
}

export async function start(env, { platform, profileId, label, instance }) {
  const provider = PROVIDERS[platform];
  if (!provider) throw new Error(`${platform} does not use OAuth here.`);
  const { clientId } = credentials(env, platform);
  if (!clientId) throw new Error(`${platform.toUpperCase()}_CLIENT_ID is not set on the Worker.`);

  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const connectionId = id("conn");
  const pkce = provider.pkce ? await pkcePair() : {};

  await env.HUB.put(KEY.state(state), JSON.stringify({
    platform, profileId, label, instance, connectionId, verifier: pkce.verifier || null,
  }), { expirationTtl: 900 });

  return {
    url: authorizeUrl(platform, {
      clientId,
      redirectUri: callbackUrl(env),
      state,
      challenge: pkce.challenge,
      instance,
    }),
    connectionId,
  };
}

export async function callback(env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const raw = state ? await env.HUB.get(KEY.state(state)) : null;
  if (!raw) return page("This authorisation link has expired. Start again from Broadcast Desk.", false);
  await env.HUB.delete(KEY.state(state));
  const pending = JSON.parse(raw);

  if (error) return page(`${pending.platform} refused the request: ${error}`, false);
  if (!code) return page("No authorisation code came back.", false);

  const provider = PROVIDERS[pending.platform];
  const { clientId, clientSecret } = credentials(env, pending.platform);
  const { token: tokenUrl } = endpointsFor(pending.platform, pending.instance);
  const { headers, body } = tokenRequest(pending.platform, {
    clientId, clientSecret, code,
    redirectUri: callbackUrl(env),
    verifier: pending.verifier,
    userAgent: env.USER_AGENT,
  });

  const res = await fetch(tokenUrl, { method: "POST", headers, body: body.toString() });
  const text = await res.text();
  let tokens;
  try { tokens = JSON.parse(text); } catch (e) { tokens = Object.fromEntries(new URLSearchParams(text)); }
  if (tokens && tokens.data && tokens.data.access_token) tokens = tokens.data;
  if (!res.ok || !tokens.access_token) {
    return page(`${pending.platform} rejected the token exchange (${res.status}).`, false);
  }

  const conn = {
    id: pending.connectionId,
    platform: pending.platform,
    profileId: pending.profileId,
    label: pending.label,
    instance: pending.instance || null,
    connectedAt: nowIso(),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    scope: tokens.scope || (provider.scopes || []).join(" "),
    meta: {},
  };

  try {
    if (provider.after) Object.assign(conn.meta, await provider.after(fetchJson, tokens, conn));
    if (provider.me) Object.assign(conn.meta, await provider.me(fetchJson, conn.accessToken, conn, env.USER_AGENT));
  } catch (e) {
    conn.meta.lookupError = String(e.message || e);
  }

  await saveConnection(env, conn);
  // The app collects it from here; the pickup window is deliberately short.
  await env.HUB.put(KEY.pickup(conn.id), await seal(env, conn), { expirationTtl: 1800 });

  return page(
    `${pending.platform} connected as ${conn.meta.handle || pending.label || "your account"}. ` +
    `Go back to Broadcast Desk and press "I approved it".`, true);
}

/** Refresh a token the relay holds for unattended sending. */
export async function ensureFresh(env, conn) {
  if (!conn.refreshToken || !conn.expiresAt) return conn;
  if (new Date(conn.expiresAt).getTime() - Date.now() > 120000) return conn;

  const provider = PROVIDERS[conn.platform];
  if (!provider) return conn;
  const { clientId, clientSecret } = credentials(env, conn.platform);
  const { token: tokenUrl } = endpointsFor(conn.platform, conn.instance);
  const { headers, body } = tokenRequest(conn.platform, {
    clientId, clientSecret, refreshToken: conn.refreshToken, userAgent: env.USER_AGENT,
  });

  const res = await fetch(tokenUrl, { method: "POST", headers, body: body.toString() });
  if (!res.ok) return conn;
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) return conn;

  const next = {
    ...conn,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || conn.refreshToken,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
  };
  await saveConnection(env, next);
  return next;
}

function page(message, ok) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return new Response(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "Connected" : "Could not connect"}</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;background:#FAF7EF;color:#1B1710;display:grid;
      place-items:center;min-height:100vh;margin:0;padding:1.5rem}
 .box{max-width:34rem;background:#fff;border:1px solid #E4DBC6;border-radius:14px;padding:1.6rem}
 .mark{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:#fff;
       font-weight:700;margin-bottom:.9rem;background:${ok ? "#0E7C55" : "#A13327"}}
 h1{font-size:1.15rem;margin:0 0 .5rem}
</style>
<div class="box"><div class="mark">${ok ? "✓" : "!"}</div>
<h1>${ok ? "Connected" : "Could not connect"}</h1><p>${safe}</p></div>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
