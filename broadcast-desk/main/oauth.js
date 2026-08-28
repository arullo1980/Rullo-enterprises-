/**
 * Connecting accounts.
 *
 * Two routes, chosen by the network rather than by us:
 *
 *   loopback  the app opens the system browser, listens on 127.0.0.1 for the
 *             redirect, and does the token exchange itself. Nothing leaves
 *             this machine. X, Reddit, Tumblr, Vimeo and Mastodon allow it.
 *
 *   hosted    Meta, TikTok, Pinterest and LinkedIn refuse a loopback redirect,
 *             so the relay takes the callback and the app collects the result
 *             over an authenticated pickup. The token still ends up here.
 *
 * Either way the account holder authorises on the network's own page and we
 * never see a password. That is what makes operating a client's account
 * defensible, and it is the only version that survives them turning on 2FA.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const { shell, net } = require("electron");
const { shared } = require("./shared.js");
const vault = require("./vault.js");
const relay = require("./relay.js");
const settings = require("./settings.js");

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function pkce() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function fetchJson(url, options) {
  const res = await net.fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok) {
    const detail = (data && (data.error_description || data.message || data.error)) || text.slice(0, 160);
    throw new Error(`${new URL(url).host} returned ${res.status}: ${detail}`);
  }
  return data;
}

/* ------------------------------------------------------------- loopback */

async function loopbackConnect(platformId, opts) {
  const { platforms, providers } = await shared();
  const p = platforms.platform(platformId);
  const provider = providers.PROVIDERS[platformId];
  if (!provider) throw new Error(`${p.name} does not use OAuth.`);

  const creds = settings.networkCreds(platformId);
  if (!creds.clientId) {
    throw new Error(`Add your ${p.name} developer app's client id first — Settings → Networks.`);
  }

  const state = base64url(crypto.randomBytes(24));
  const codes = provider.pkce ? pkce() : {};

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const q = Object.fromEntries(url.searchParams);
      try {
        if (q.error) throw new Error(`${p.name} refused the request: ${q.error_description || q.error}`);
        if (q.state !== state) throw new Error("The authorisation reply did not match this request — start again.");
        if (!q.code) throw new Error("No authorisation code came back.");

        const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const conn = await exchange(platformId, {
          code: q.code, redirectUri, verifier: codes.verifier,
          clientId: creds.clientId, clientSecret: creds.clientSecret,
          profileId: opts.profileId, label: opts.label, instance: opts.instance,
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(resultPage(true, `Connected as ${conn.meta.handle || opts.label || "your account"}. You can close this tab.`));
        server.close();
        resolve(vault.summarise(conn));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(resultPage(false, e.message));
        server.close();
        reject(e);
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const url = providers.authorizeUrl(platformId, {
          clientId: creds.clientId,
          redirectUri,
          state,
          challenge: codes.challenge,
          instance: opts.instance,
          scopes: opts.scopes,
        });
        await shell.openExternal(url);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    setTimeout(() => {
      try { server.close(); } catch (e) { /* closed */ }
      reject(new Error("The authorisation window timed out after ten minutes."));
    }, 10 * 60 * 1000).unref();
  });
}

/* -------------------------------------------------------------- exchange */

async function exchange(platformId, opts) {
  const { providers } = await shared();
  const provider = providers.PROVIDERS[platformId];
  const { token: tokenUrl } = providers.endpointsFor(platformId, opts.instance);
  const { headers, body } = providers.tokenRequest(platformId, {
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    code: opts.code,
    redirectUri: opts.redirectUri,
    verifier: opts.verifier,
    userAgent: settings.get().userAgent,
  });

  let tokens = await fetchJson(tokenUrl, { method: "POST", headers, body: body.toString() });
  if (tokens.data && tokens.data.access_token) tokens = tokens.data;   // Threads/IG shape
  if (!tokens.access_token) throw new Error(`${platformId} did not return an access token.`);

  const conn = {
    platform: platformId,
    profileId: opts.profileId,
    label: opts.label,
    instance: opts.instance || null,
    connectedAt: new Date().toISOString(),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    scope: tokens.scope || (provider.scopes || []).join(" "),
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    meta: {},
  };

  // Identity lookup is a convenience; losing a good token over it would not be.
  try {
    if (provider.after) Object.assign(conn.meta, await provider.after(fetchJson, tokens, conn));
    if (provider.me) Object.assign(conn.meta, await provider.me(fetchJson, conn.accessToken, conn, settings.get().userAgent));
  } catch (e) {
    conn.meta.lookupError = String(e.message || e);
  }

  vault.save(conn);
  return conn;
}

/* ---------------------------------------------------------------- hosted */

async function hostedConnect(platformId, opts) {
  if (!relay.configured()) {
    const { platforms } = await shared();
    throw new Error(
      `${platforms.platform(platformId).name} will not redirect to a local address, so it needs the relay. ` +
      `Set it up in Settings → Relay first.`
    );
  }
  const started = await relay.startHostedAuth(platformId, {
    profileId: opts.profileId, label: opts.label, instance: opts.instance,
  });
  await shell.openExternal(started.url);
  return { pendingId: started.connectionId, hosted: true };
}

/** Called by the renderer once the operator says they approved it. */
async function finishHosted(connectionId, { keepInCloud }) {
  const payload = await relay.pickup(connectionId);
  if (!payload || !payload.connection) throw new Error("The relay has not seen that authorisation complete yet.");
  const conn = vault.save({ ...payload.connection, id: connectionId });
  // The relay only keeps its copy if this account is meant to post unattended.
  if (!keepInCloud) await relay.dropConnection(connectionId).catch(() => {});
  return vault.summarise(conn);
}

/* ---------------------------------------------------------------- tokens */

/** Refresh if the token is close to expiring. Returns a usable connection. */
async function ensureFresh(conn) {
  if (!conn.refreshToken || !conn.expiresAt) return conn;
  if (new Date(conn.expiresAt).getTime() - Date.now() > 120000) return conn;

  const { providers } = await shared();
  const provider = providers.PROVIDERS[conn.platform];
  if (!provider) return conn;

  try {
    const { token: tokenUrl } = providers.endpointsFor(conn.platform, conn.instance);
    const { headers, body } = providers.tokenRequest(conn.platform, {
      clientId: conn.clientId, clientSecret: conn.clientSecret,
      refreshToken: conn.refreshToken, userAgent: settings.get().userAgent,
    });
    const t = await fetchJson(tokenUrl, { method: "POST", headers, body: body.toString() });
    if (!t.access_token) return conn;
    const next = {
      ...conn,
      accessToken: t.access_token,
      refreshToken: t.refresh_token || conn.refreshToken,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
    };
    vault.save(next);
    return next;
  } catch (e) {
    // An expired token that cannot refresh is reported at send time, where the
    // operator can see which account it was.
    return conn;
  }
}

/* ----------------------------------------------- paste-a-secret networks */

/** Bluesky, Telegram, Discord, WordPress: verify, then store. */
async function connectWithCredentials(platformId, opts) {
  const probe = await probe(platformId, opts.credentials, opts);
  if (!probe.ok) throw new Error(probe.error);
  const conn = vault.save({
    platform: platformId,
    profileId: opts.profileId,
    label: opts.label,
    instance: opts.instance || null,
    connectedAt: new Date().toISOString(),
    credentials: opts.credentials,
    meta: probe.meta || {},
  });
  return conn;
}

async function probe(platformId, credentials, opts) {
  try {
    if (platformId === "telegram") {
      const d = await fetchJson(`https://api.telegram.org/bot${credentials.botToken}/getMe`);
      if (!d.ok) return { ok: false, error: "Telegram rejected that bot token." };
      return { ok: true, meta: { handle: d.result.username, remoteId: d.result.id } };
    }
    if (platformId === "discord") {
      const d = await fetchJson(credentials.webhookUrl);
      return { ok: true, meta: { handle: d.name, remoteId: d.id, channelId: d.channel_id } };
    }
    if (platformId === "bluesky") {
      const host = (opts && opts.instance) || "bsky.social";
      const d = await fetchJson(`https://${host}/xrpc/com.atproto.server.createSession`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: credentials.identifier, password: credentials.appPassword }),
      });
      return { ok: true, meta: { handle: d.handle, remoteId: d.did } };
    }
    if (platformId === "wordpress") {
      const site = String(credentials.siteUrl || "").replace(/\/+$/, "");
      if (!site) return { ok: false, error: "Enter the site URL." };
      const auth = "Basic " + Buffer.from(
        `${credentials.username}:${String(credentials.appPassword).replace(/\s+/g, "")}`).toString("base64");
      const d = await fetchJson(`${site}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: auth } });
      if (!d || !d.id) return { ok: false, error: "WordPress did not recognise that user." };
      // Posting rights are what matter; being able to log in is not the same thing.
      const caps = d.capabilities || {};
      if (caps.publish_posts === false) {
        return { ok: false, error: `${d.name} can sign in but cannot publish posts on that site.` };
      }
      return { ok: true, meta: { handle: d.slug || d.name, remoteId: d.id, siteUrl: site, name: d.name } };
    }
    return { ok: true, meta: {} };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function resultPage(ok, message) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return `<!doctype html><meta charset="utf-8">
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
<h1>${ok ? "Connected" : "Could not connect"}</h1><p>${safe}</p></div>`;
}

module.exports = { loopbackConnect, hostedConnect, finishHosted, connectWithCredentials, ensureFresh, fetchJson };
