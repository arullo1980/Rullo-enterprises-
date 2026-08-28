/**
 * Broadcast Desk — the relay.
 *
 * The desktop app holds its own credentials and posts by itself. This Worker
 * covers the three things a program on someone's desk cannot do: take the OAuth
 * callback for networks that refuse a loopback redirect, host media at a public
 * URL for networks that fetch the file themselves, and run the queue on a cron
 * so scheduled posts go out with the machine off.
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
  saveConnection, loadConnection, dropConnection, listConnections, withinRate, seal, unseal,
} from "./lib.js";
import { start as oauthStart, callback as oauthCallback, ensureFresh } from "./oauth.js";
import { publish as publishVia, act as actVia } from "../../shared/adapters.js";
import { collectFeed } from "./feed.js";

const VERSION = "broadcast-desk-relay/1.0";

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

  // Instagram fetches media itself and cannot present a key, so this route is
  // public. The keys are unguessable and the objects expire.
  if (path.startsWith("/media/") && !path.startsWith("/media/put/") && request.method === "GET") {
    if (!env.MEDIA) return json({ error: "No R2 bucket is bound." }, 501);
    const key = decodeURIComponent(path.slice("/media/".length));
    const object = await env.MEDIA.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": (object.httpMetadata && object.httpMetadata.contentType) || "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

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

  // The desktop app collects a connection the relay finished authorising.
  if (path === "/connect/pickup" && request.method === "POST") {
    const { connectionId } = await request.json();
    const packed = await env.HUB.get(KEY.pickup(connectionId));
    if (!packed) return json({ error: "That authorisation has not completed, or the pickup window has passed." }, 404);
    const connection = await unseal(env, packed);
    // One pickup only: the token is on the operator's machine from here.
    await env.HUB.delete(KEY.pickup(connectionId));
    return json({ connection });
  }

  // The app pushes a copy of a token here when an account is set to send
  // unattended. Nothing arrives here unless the operator asked for it.
  if (path === "/connections/store" && request.method === "POST") {
    const { connection } = await request.json();
    if (!connection || !connection.platform) return json({ error: "A connection is required." }, 400);
    const meta = await saveConnection(env, { ...connection, unattended: true, storedAt: nowIso() });
    return json({ ok: true, connection: meta });
  }

  // A short-lived public URL for media a network insists on fetching itself.
  if (path === "/media/slot" && request.method === "POST") {
    if (!env.MEDIA) return json({ error: "No R2 bucket is bound to this Worker (binding MEDIA)." }, 501);
    const { name, type, size } = await request.json();
    if (!size || size > Number(env.MAX_MEDIA_BYTES || 200 * 1024 * 1024)) {
      return json({ error: "That file is larger than this relay accepts." }, 413);
    }
    const key = `${id("med")}/${(name || "upload").replace(/[^\w.-]+/g, "_")}`;
    await env.HUB.put(KEY.media(key), JSON.stringify({ type, size, at: nowIso() }), { expirationTtl: 60 * 60 * 24 * 3 });
    return json({
      uploadUrl: `${env.PUBLIC_URL.replace(/\/+$/, "")}/media/put/${encodeURIComponent(key)}?k=${await slotToken(env, key)}`,
      publicUrl: `${env.PUBLIC_URL.replace(/\/+$/, "")}/media/${encodeURIComponent(key)}`,
      key,
    });
  }

  if (path.startsWith("/media/put/") && request.method === "PUT") {
    if (!env.MEDIA) return json({ error: "No R2 bucket is bound." }, 501);
    const key = decodeURIComponent(path.slice("/media/put/".length));
    const given = url.searchParams.get("k");
    if (given !== await slotToken(env, key)) return json({ error: "Bad upload token." }, 403);
    await env.MEDIA.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
    });
    return json({ ok: true });
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
      const fresh = await ensureFresh(env, conn);
      const r = await actVia(fresh, action, ioFor(env));
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

/**
 * Media, as the relay sees it. Everything it sends was uploaded here first, so
 * a reference is always a URL — there is no disk on this side.
 */
function ioFor(env) {
  return {
    userAgent: env.USER_AGENT || "broadcast-desk/1.0",
    read: async (ref) => {
      const url = ref && (ref.url || ref);
      if (!url) throw new Error("This post needs media, but none was uploaded with it.");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not fetch the media for this post (${res.status}).`);
      return {
        name: ref.name || "upload",
        type: ref.type || res.headers.get("Content-Type") || "application/octet-stream",
        size: Number(res.headers.get("Content-Length") || 0) || (ref.size || 0),
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    },
    publicUrl: async (ref) => {
      const url = ref && (ref.url || ref);
      if (!url) throw new Error("This network fetches media from a URL, and none was uploaded.");
      return url;
    },
  };
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
      const fresh = await ensureFresh(env, conn);
      const r = await publishVia(fresh, item, ioFor(env));
      results.push({
        accountId: item.accountId, ok: true,
        url: r.url || null, remoteId: r.remoteId || null,
        note: r.note || null, postedAt: nowIso(),
      });
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

/** Upload tokens are derived, not stored: same key in, same token out. */
async function slotToken(env, key) {
  const data = new TextEncoder().encode(`${key}:${env.TOKEN_KEY || ""}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
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
