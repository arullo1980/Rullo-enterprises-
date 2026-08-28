/**
 * Feed collection — the mentions and keyword hits the rules run against.
 *
 * Only implemented where the network has a usable read API on the same token
 * the desk already holds. Anything else returns nothing rather than pretending:
 * a rule that silently never fires is worse than one that says why.
 */

import { ensureFresh } from "./oauth.js";

const UA = (env) => env.USER_AGENT || "broadcast-desk/1.0";

export async function collectFeed(env, connections, since) {
  const items = [];
  for (const conn of connections) {
    try {
      const fresh = await ensureFresh(env, conn);
      if (conn.platform === "x") items.push(...(await xMentions(env, fresh, since)));
      else if (conn.platform === "mastodon") items.push(...(await mastodonMentions(env, fresh, since)));
      else if (conn.platform === "bluesky") items.push(...(await blueskyMentions(env, fresh, since)));
    } catch (e) {
      items.push({
        id: `err_${conn.id}`,
        kind: "error",
        platform: conn.platform,
        connectionId: conn.id,
        text: `Could not read ${conn.platform}: ${e.message || e}`,
        at: new Date().toISOString(),
        author: {},
      });
    }
  }
  return items.sort((a, b) => new Date(b.at) - new Date(a.at));
}

async function xMentions(env, conn, since) {
  const me = conn.meta && conn.meta.remoteId;
  if (!me) return [];
  const params = new URLSearchParams({
    max_results: "25",
    "tweet.fields": "created_at,lang,referenced_tweets,author_id",
    expansions: "author_id",
    "user.fields": "username,public_metrics,verified",
  });
  if (since) params.set("start_time", new Date(since).toISOString());
  const r = await fetch(`https://api.x.com/2/users/${me}/mentions?${params}`, {
    headers: { Authorization: `Bearer ${conn.accessToken}`, "User-Agent": UA(env) },
  });
  if (!r.ok) throw new Error(`X returned ${r.status}`);
  const d = await r.json();
  const users = Object.fromEntries(((d.includes || {}).users || []).map((u) => [u.id, u]));
  return (d.data || []).map((t) => {
    const u = users[t.author_id] || {};
    return {
      id: `x_${t.id}`,
      externalId: t.id,
      kind: "mention",
      platform: "x",
      connectionId: conn.id,
      text: t.text,
      lang: t.lang,
      at: t.created_at,
      url: `https://x.com/i/status/${t.id}`,
      isReply: (t.referenced_tweets || []).some((r2) => r2.type === "replied_to"),
      isRepost: (t.referenced_tweets || []).some((r2) => r2.type === "retweeted"),
      author: {
        handle: u.username,
        name: u.name,
        followers: (u.public_metrics || {}).followers_count || 0,
        verified: !!u.verified,
      },
    };
  });
}

async function mastodonMentions(env, conn, since) {
  const r = await fetch(`https://${conn.instance}/api/v1/notifications?types[]=mention&limit=30`, {
    headers: { Authorization: `Bearer ${conn.accessToken}`, "User-Agent": UA(env) },
  });
  if (!r.ok) throw new Error(`Mastodon returned ${r.status}`);
  const d = await r.json();
  return (d || [])
    .filter((n) => !since || n.created_at > since)
    .map((n) => ({
      id: `ma_${n.id}`,
      externalId: n.status ? n.status.id : n.id,
      kind: "mention",
      platform: "mastodon",
      connectionId: conn.id,
      text: stripHtml((n.status || {}).content || ""),
      lang: (n.status || {}).language,
      at: n.created_at,
      url: (n.status || {}).url,
      isReply: Boolean((n.status || {}).in_reply_to_id),
      isRepost: Boolean((n.status || {}).reblog),
      author: {
        handle: (n.account || {}).acct,
        name: (n.account || {}).display_name,
        followers: (n.account || {}).followers_count || 0,
        verified: Boolean(((n.account || {}).fields || []).some((f) => f.verified_at)),
      },
    }));
}

async function blueskyMentions(env, conn, since) {
  const host = conn.instance || "bsky.social";
  const s = await fetch(`https://${host}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: conn.credentials.identifier, password: conn.credentials.appPassword }),
  }).then((r) => r.json());
  if (!s.accessJwt) throw new Error("Bluesky session failed");

  const r = await fetch(`https://${host}/xrpc/app.bsky.notification.listNotifications?limit=30`, {
    headers: { Authorization: `Bearer ${s.accessJwt}` },
  });
  if (!r.ok) throw new Error(`Bluesky returned ${r.status}`);
  const d = await r.json();
  return (d.notifications || [])
    .filter((n) => ["mention", "reply"].includes(n.reason))
    .filter((n) => !since || n.indexedAt > since)
    .map((n) => ({
      id: `bs_${n.cid}`,
      externalId: n.uri,
      targetCid: n.cid,
      kind: n.reason === "reply" ? "reply" : "mention",
      platform: "bluesky",
      connectionId: conn.id,
      text: (n.record || {}).text || "",
      at: n.indexedAt,
      url: null,
      isReply: n.reason === "reply",
      isRepost: false,
      author: {
        handle: (n.author || {}).handle,
        name: (n.author || {}).displayName,
        followers: 0,
        verified: false,
      },
    }));
}

function stripHtml(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}
