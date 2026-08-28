/**
 * Broadcast Desk — social-hub Worker.
 *
 * The console at /app is a static page: it can hold a plan, but it must never
 * hold a credential. This Worker is the other half. It owns the OAuth dance,
 * keeps every token encrypted in KV, fans a post out across networks, and runs
 * the queue on a cron so scheduled posts go out with nothing open.
 *
 * Routes (all under the desk key except the OAuth callback):
 *   GET    /health
 *   POST   /connect/start        -> { url, connectionId }
 *   GET    /oauth/callback       <- the network redirects here
 *   POST   /connect/token        -> { connectionId }   (app passwords, bot tokens)
 *   GET    /connections          -> [{ id, platform, label }]
 *   DELETE /connections/:id
 *   POST   /publish              -> { results: [...] }
 *   POST   /act                  -> { ok }
 *   POST   /feed                 -> { items: [...] }
 *   POST   /queue/sync           -> { synced }
 *   POST   /queue/results        -> { results }
 *
 * Secrets (wrangler secret put …):
 *   DESK_KEY        shared secret the console sends as a bearer token
 *   TOKEN_KEY       encryption key for tokens at rest
 *   <PLATFORM>_CLIENT_ID / _CLIENT_SECRET  per OAuth network
 */

import {
  json, corsHeaders, authorised, id, nowIso, KEY,
  saveConnection, loadConnection, dropConnection, listConnections, withinRate, seal,
} from "./lib.js";
import { start as oauthStart, callback as oauthCallback } from "./oauth.js";
import { publishItem, actItem } from "./adapters.js";
import { collectFeed } from "./feed.js";

const VERSION = "social-hub/1.0";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const res = await route(request, env, ctx, url);
      for (const [k, v] of Object.entries(cors)) {
        if (!res.headers.has(k)) res.headers.set(k, v);
      }
      return res;
    } catch (e) {
      console.error("unhandled", e && e.stack);
      return json({ error: String((e && e.message) || e) }, 500, cors);
    }
  },

  /** Cron: send whatever has come due. Configured in wrangler.toml. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainQueue(env));
  },
};

async function route(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    return json({ ok: true, version: VERSION, at: nowIso(), connections: (await listConnections(env)).length });
  }

  // The network redirects a browser here; the one-time state is its credential.
  if (path === "/oauth/callback") return oauthCallback(env, url);

  if (!authorised(request, env)) {
    return json({ error: "Unauthorised. Set the desk key in Settings → Backend." }, 401);
  }

  if (path === "/connect/start" && request.method === "POST") {
    const body = await request.json();
    const r = await oauthStart(env, body);
    return json(r);
  }

  if (path === "/connect/token" && request.method === "POST") {
    const { platform, profileId, label, credentials } = await request.json();
    if (!platform || !credentials) return json({ error: "platform and credentials are required." }, 400);
    const conn = {
      id: id("conn"), platform, profileId, label,
      connectedAt: nowIso(), credentials, meta: {},
    };
    // Fail the connection here rather than at the first post.
    const probe = await probeConnection(env, conn);
    if (!probe.ok) return json({ error: probe.error }, 400);
    Object.assign(conn.meta, probe.meta || {});
    const meta = await saveConnection(env, conn);
    return json({ connectionId: conn.id, connection: meta });
  }

  if (path === "/connections" && request.method === "GET") {
    return json({ connections: await listConnections(env) });
  }

  if (path.startsWith("/connections/") && request.method === "DELETE") {
    await dropConnection(env, decodeURIComponent(path.split("/")[2]));
    return json({ ok: true });
  }

  if (path === "/publish" && request.method === "POST") {
    const { items } = await request.json();
    return json({ results: await publishMany(env, items || []) });
  }

  if (path === "/act" && request.method === "POST") {
    const action = await request.json();
    const conn = await loadConnection(env, action.connectionId);
    if (!conn) return json({ ok: false, error: "That account is not connected here." }, 400);
    if (!(await withinRate(env, conn.id, Number(env.MAX_ACTIONS_PER_HOUR || 30)))) {
      return json({ ok: false, error: "Worker rate ceiling reached for this account." }, 429);
    }
    try {
      const r = await actItem(env, conn, action);
      return json({ ok: true, ...r });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 200);
    }
  }

  if (path === "/feed" && request.method === "POST") {
    const { connectionIds, since } = await request.json();
    const conns = [];
    for (const cid of connectionIds || (await listConnections(env)).map((c) => c.id)) {
      const c = await loadConnection(env, cid);
      if (c) conns.push(c);
    }
    return json({ items: await collectFeed(env, conns, since) });
  }

  if (path === "/queue/sync" && request.method === "POST") {
    const { posts = [], remove = [] } = await request.json();
    let synced = 0;
    for (const p of posts) {
      if (!p.id || !p.scheduledAt || !(p.items || []).length) continue;
      await env.HUB.put(KEY.queued(p.scheduledAt, p.id), await seal(env, p), {
        // Keep a sent post's key around briefly so a double sync cannot resend it.
        expirationTtl: 60 * 60 * 24 * 45,
      });
      synced++;
    }
    for (const rid of remove) {
      const list = await env.HUB.list({ prefix: "queue:" });
      for (const k of list.keys) if (k.name.endsWith(`:${rid}`)) await env.HUB.delete(k.name);
    }
    return json({ synced, removed: remove.length });
  }

  if (path === "/queue/results" && request.method === "POST") {
    const { since } = await request.json();
    const list = await env.HUB.list({ prefix: "result:" });
    const results = [];
    for (const k of list.keys) {
      const raw = await env.HUB.get(k.name);
      if (!raw) continue;
      const r = JSON.parse(raw);
      if (!since || r.sentAt > since) results.push(r);
    }
    return json({ results });
  }

  return json({ error: "No such endpoint." }, 404);
}

/* ------------------------------------------------------------- publishing */

/**
 * Fan out. Deliberately serial with a short pause between accounts: a burst of
 * identical posts landing on twelve networks in the same second is the exact
 * signature the platforms score as automation.
 */
async function publishMany(env, items) {
  const results = [];
  const gap = Number(env.FANOUT_GAP_MS || 400);

  for (const item of items) {
    const conn = item.connectionId ? await loadConnection(env, item.connectionId) : null;
    if (!conn) {
      results.push({ accountId: item.accountId, ok: false, error: "That account is not connected here." });
      continue;
    }
    if (!(await withinRate(env, conn.id, Number(env.MAX_POSTS_PER_HOUR || 20)))) {
      results.push({ accountId: item.accountId, ok: false, error: "Worker rate ceiling reached for this account." });
      continue;
    }
    try {
      const r = await publishItem(env, conn, item);
      results.push({ accountId: item.accountId, ok: true, url: r.url || null, remoteId: r.remoteId || null, postedAt: nowIso() });
    } catch (e) {
      results.push({ accountId: item.accountId, ok: false, error: String(e.message || e) });
    }
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
  return results;
}

/**
 * Cron drain. Queue keys are `queue:<iso>:<id>`, so the lexical order is
 * chronological and everything before "now" is due.
 */
async function drainQueue(env) {
  const cutoff = `queue:${nowIso()}`;
  const list = await env.HUB.list({ prefix: "queue:" });
  const dueKeys = list.keys.map((k) => k.name).filter((name) => name <= cutoff).sort();

  for (const key of dueKeys.slice(0, Number(env.MAX_PER_RUN || 25))) {
    const packed = await env.HUB.get(key);
    if (!packed) continue;
    let post;
    try {
      const { unseal } = await import("./lib.js");
      post = await unseal(env, packed);
    } catch (e) {
      await env.HUB.delete(key);
      continue;
    }
    // Delete first: a post that fails is recorded as failed, never silently retried
    // in a loop that could publish it twice.
    await env.HUB.delete(key);
    const results = await publishMany(env, post.items || []);
    await env.HUB.put(KEY.result(post.id), JSON.stringify({
      postId: post.id, sentAt: nowIso(), results,
    }), { expirationTtl: 60 * 60 * 24 * 30 });
  }
}

/* ------------------------------------------------------------ connections */

/** Verify a pasted credential works before it is stored as a connection. */
async function probeConnection(env, conn) {
  try {
    if (conn.platform === "telegram") {
      const r = await fetch(`https://api.telegram.org/bot${conn.credentials.botToken}/getMe`);
      const d = await r.json();
      if (!d.ok) return { ok: false, error: "Telegram rejected that bot token." };
      return { ok: true, meta: { handle: d.result.username, remoteId: d.result.id } };
    }
    if (conn.platform === "discord") {
      const r = await fetch(conn.credentials.webhookUrl);
      if (!r.ok) return { ok: false, error: "That Discord webhook URL is not reachable." };
      const d = await r.json();
      return { ok: true, meta: { handle: d.name, remoteId: d.id } };
    }
    if (conn.platform === "bluesky") {
      const host = conn.instance || "bsky.social";
      const r = await fetch(`https://${host}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: conn.credentials.identifier,
          password: conn.credentials.appPassword,
        }),
      });
      if (!r.ok) return { ok: false, error: "Bluesky rejected that handle and app password." };
      const d = await r.json();
      return { ok: true, meta: { handle: d.handle, remoteId: d.did } };
    }
    return { ok: true, meta: {} };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
