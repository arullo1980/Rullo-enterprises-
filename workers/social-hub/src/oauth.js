/**
 * OAuth 2.0 authorisation-code flow, with PKCE where the network supports it.
 *
 * One flow covers every OAuth network; the per-network differences live in
 * PROVIDERS below. A connection is only ever created by the network redirecting
 * back here with a code — the desk cannot mint one, and no password is involved
 * at any point, which is what makes connecting a *client's* account safe to do.
 */

import { b64, id, KEY, saveConnection, nowIso } from "./lib.js";

export const PROVIDERS = {
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    pkce: true,
    basicAuth: true,          // confidential client: id/secret in the Basic header
    me: async (token) => {
      const r = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      return d && d.data ? { handle: d.data.username, remoteId: d.data.id, name: d.data.name } : {};
    },
  },
  mastodon: {
    // Every instance is its own OAuth server, so the host comes from the request.
    dynamic: (instance) => ({
      authorize: `https://${instance}/oauth/authorize`,
      token: `https://${instance}/oauth/token`,
    }),
    scopes: ["read", "write:statuses", "write:media"],
    pkce: false,
    me: async (token, conn) => {
      const r = await fetch(`https://${conn.instance}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      return { handle: d.username, remoteId: d.id, name: d.display_name };
    },
  },
  linkedin: {
    authorize: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["w_member_social", "openid", "profile"],
    pkce: false,
    me: async (token) => {
      const r = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      return { handle: d.name, remoteId: d.sub, name: d.name };
    },
  },
  facebook: {
    authorize: "https://www.facebook.com/v21.0/dialog/oauth",
    token: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
    pkce: false,
    // A user token is not what posts: exchange it for the Page's own token.
    after: async (tokens) => {
      const r = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${encodeURIComponent(tokens.access_token)}`);
      const d = await r.json();
      const page = (d.data || [])[0];
      if (!page) return {};
      return { pageId: page.id, pageToken: page.access_token, handle: page.name };
    },
  },
  instagram: {
    authorize: "https://www.instagram.com/oauth/authorize",
    token: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    pkce: false,
    form: true,
  },
  threads: {
    authorize: "https://threads.net/oauth/authorize",
    token: "https://graph.threads.net/oauth/access_token",
    scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies"],
    pkce: false,
    form: true,
  },
  reddit: {
    authorize: "https://www.reddit.com/api/v1/authorize",
    token: "https://www.reddit.com/api/v1/access_token",
    scopes: ["submit", "identity", "read", "history"],
    pkce: false,
    basicAuth: true,
    extraAuthParams: { duration: "permanent" },
    me: async (token, conn, env) => {
      const r = await fetch("https://oauth.reddit.com/api/v1/me", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": env.USER_AGENT || "broadcast-desk/1.0" },
      });
      const d = await r.json();
      return { handle: d.name, remoteId: d.id };
    },
  },
  tumblr: {
    authorize: "https://www.tumblr.com/oauth2/authorize",
    token: "https://api.tumblr.com/v2/oauth2/token",
    scopes: ["basic", "write", "offline_access"],
    pkce: true,
  },
  pinterest: {
    authorize: "https://www.pinterest.com/oauth/",
    token: "https://api.pinterest.com/v5/oauth/token",
    scopes: ["pins:write", "boards:read"],
    pkce: false,
    basicAuth: true,
  },
  tiktok: {
    authorize: "https://www.tiktok.com/v2/auth/authorize/",
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["video.publish", "user.info.basic"],
    pkce: true,
    clientKeyParam: "client_key",       // TikTok does not call it client_id
  },
  youtube: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"],
    pkce: true,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
};

/** Credentials are per-platform secrets: X_CLIENT_ID / X_CLIENT_SECRET etc. */
export function credentials(env, platform) {
  const up = platform.toUpperCase();
  return { clientId: env[`${up}_CLIENT_ID`], clientSecret: env[`${up}_CLIENT_SECRET`] };
}

function endpoints(platform, provider, instance) {
  if (provider.dynamic) {
    if (!instance) throw new Error(`${platform} needs an instance host.`);
    return provider.dynamic(instance);
  }
  return { authorize: provider.authorize, token: provider.token };
}

async function pkcePair() {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64(new Uint8Array(digest)) };
}

/** Build the URL the user is sent to, and stash what the callback will need. */
export async function start(env, { platform, profileId, label, instance, redirect }) {
  const provider = PROVIDERS[platform];
  if (!provider) throw new Error(`${platform} does not use OAuth here.`);
  const { clientId } = credentials(env, platform);
  if (!clientId) throw new Error(`${platform.toUpperCase()}_CLIENT_ID is not set on the Worker.`);

  const { authorize } = endpoints(platform, provider, instance);
  const state = b64(crypto.getRandomValues(new Uint8Array(24)));
  const connectionId = id("conn");
  const pkce = provider.pkce ? await pkcePair() : null;

  await env.HUB.put(KEY.state(state), JSON.stringify({
    platform, profileId, label, instance, redirect, connectionId,
    verifier: pkce ? pkce.verifier : null,
  }), { expirationTtl: 900 });

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: callbackUrl(env),
    scope: provider.scopes.join(provider.scopeSeparator || " "),
    state,
    ...(provider.extraAuthParams || {}),
  });
  params.set(provider.clientKeyParam || "client_id", clientId);
  if (pkce) {
    params.set("code_challenge", pkce.challenge);
    params.set("code_challenge_method", "S256");
  }
  return { url: `${authorize}?${params}`, connectionId };
}

export function callbackUrl(env) {
  if (!env.PUBLIC_URL) throw new Error("PUBLIC_URL is not set on the Worker.");
  return `${env.PUBLIC_URL.replace(/\/+$/, "")}/oauth/callback`;
}

/** Handle the network's redirect back: swap the code for tokens and store them. */
export async function callback(env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const raw = state ? await env.HUB.get(KEY.state(state)) : null;
  if (!raw) return page("This authorisation link has expired. Start again from the desk.", false);
  await env.HUB.delete(KEY.state(state));
  const pending = JSON.parse(raw);

  if (error) return page(`${pending.platform} refused the request: ${error}`, false);
  if (!code) return page("No authorisation code came back.", false);

  const provider = PROVIDERS[pending.platform];
  const { clientId, clientSecret } = credentials(env, pending.platform);
  const { token: tokenUrl } = endpoints(pending.platform, provider, pending.instance);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(env),
  });
  if (pending.verifier) body.set("code_verifier", pending.verifier);

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (provider.basicAuth) {
    headers.Authorization = "Basic " + btoa(`${clientId}:${clientSecret}`);
    body.set("client_id", clientId);
  } else {
    body.set(provider.clientKeyParam || "client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  }
  if (env.USER_AGENT) headers["User-Agent"] = env.USER_AGENT;

  const res = await fetch(tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  let tokens;
  try { tokens = JSON.parse(text); } catch (e) { tokens = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok || (!tokens.access_token && !tokens.data)) {
    return page(`${pending.platform} rejected the token exchange (${res.status}).`, false);
  }
  if (tokens.data && tokens.data.access_token) tokens = tokens.data;   // Threads/IG shape

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
    scope: tokens.scope || provider.scopes.join(" "),
    meta: {},
  };

  try {
    if (provider.after) Object.assign(conn.meta, await provider.after(tokens, conn, env));
    if (provider.me) Object.assign(conn.meta, await provider.me(conn.accessToken, conn, env));
  } catch (e) {
    // Identity lookup is a nicety; a failure here must not lose a good token.
    conn.meta.lookupError = String(e.message || e);
  }

  await saveConnection(env, conn);
  return page(
    `${pending.platform} connected as ${conn.meta.handle || pending.label || "your account"}. ` +
    `You can close this tab and go back to the desk.`, true, pending.redirect);
}

/** Refresh an expiring token; returns the connection, updated if it changed. */
export async function ensureFresh(env, conn) {
  if (!conn.refreshToken || !conn.expiresAt) return conn;
  if (new Date(conn.expiresAt).getTime() - Date.now() > 120000) return conn;

  const provider = PROVIDERS[conn.platform];
  if (!provider) return conn;
  const { clientId, clientSecret } = credentials(env, conn.platform);
  const { token: tokenUrl } = endpoints(conn.platform, provider, conn.instance);

  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refreshToken });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (provider.basicAuth) headers.Authorization = "Basic " + btoa(`${clientId}:${clientSecret}`);
  else {
    body.set(provider.clientKeyParam || "client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  }

  const res = await fetch(tokenUrl, { method: "POST", headers, body });
  if (!res.ok) return conn;
  const t = await res.json();
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

/** The callback is opened in a browser tab, so it answers in HTML, not JSON. */
function page(message, ok, backTo) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return new Response(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "Connected" : "Could not connect"}</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;background:#FAF7EF;color:#1B1710;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:1.5rem}
  .box{max-width:34rem;background:#fff;border:1px solid #E4DBC6;border-radius:14px;padding:1.6rem}
  h1{font-size:1.15rem;margin:0 0 .6rem}
  a{color:#0E7C55}
  .mark{width:34px;height:34px;border-radius:9px;background:${ok ? "#0E7C55" : "#A13327"};
        display:grid;place-items:center;color:#fff;font-weight:700;margin-bottom:.9rem}
</style>
<div class="box">
  <div class="mark">${ok ? "✓" : "!"}</div>
  <h1>${ok ? "Connected" : "Could not connect"}</h1>
  <p>${safe}</p>
  ${backTo ? `<p><a href="${backTo.replace(/"/g, "&quot;")}">Back to Broadcast Desk</a></p>` : ""}
</div>`, { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
