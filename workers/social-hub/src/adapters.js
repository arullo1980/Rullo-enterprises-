/**
 * Network adapters.
 *
 * Each adapter turns a desk item into one network's API call. They all return
 * { ok, url, remoteId } or throw with a message worth showing the operator —
 * "429 from X" is useless, "X rate limit, retry after 15 min" is not.
 *
 * Adding a network means adding one entry here plus its OAuth config.
 */

import { ensureFresh } from "./oauth.js";

const UA = (env) => env.USER_AGENT || "broadcast-desk/1.0 (+https://rulloenterprises.com)";

class NetworkError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(url, options, label) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const detail =
      (data && (data.error_description || data.message ||
        (data.errors && data.errors[0] && (data.errors[0].message || data.errors[0].detail)) ||
        (data.error && (data.error.message || data.error)))) || text.slice(0, 180);
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After") || res.headers.get("x-rate-limit-reset");
      throw new NetworkError(`${label} rate limit${retry ? ` — retry in ${retry}s` : ""}.`, 429, data);
    }
    if (res.status === 401 || res.status === 403) {
      throw new NetworkError(`${label} rejected the credentials (${res.status}): ${detail}`, res.status, data);
    }
    throw new NetworkError(`${label} error ${res.status}: ${detail}`, res.status, data);
  }
  return data;
}

const bearer = (token, env) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": UA(env),
});

/* --------------------------------------------------------------------- X */

const x = {
  async publish(env, conn, item) {
    const body = { text: item.text };
    if (item.replyTo) body.reply = { in_reply_to_tweet_id: item.replyTo };
    const d = await call("https://api.x.com/2/tweets", {
      method: "POST", headers: bearer(conn.accessToken, env), body: JSON.stringify(body),
    }, "X");
    const tid = d && d.data && d.data.id;
    return { ok: true, remoteId: tid, url: tid ? `https://x.com/i/status/${tid}` : null };
  },
  async act(env, conn, action) {
    const me = conn.meta && conn.meta.remoteId;
    if (!me) throw new NetworkError("X connection is missing the account id — reconnect it.", 400);
    if (action.action === "reply") {
      return x.publish(env, conn, { text: action.text, replyTo: action.targetId });
    }
    if (action.action === "quote") {
      return x.publish(env, conn, { text: `${action.text} ${action.targetUrl || ""}`.trim() });
    }
    if (action.action === "repost") {
      await call(`https://api.x.com/2/users/${me}/retweets`, {
        method: "POST", headers: bearer(conn.accessToken, env),
        body: JSON.stringify({ tweet_id: action.targetId }),
      }, "X");
      return { ok: true };
    }
    if (action.action === "like") {
      await call(`https://api.x.com/2/users/${me}/likes`, {
        method: "POST", headers: bearer(conn.accessToken, env),
        body: JSON.stringify({ tweet_id: action.targetId }),
      }, "X");
      return { ok: true };
    }
    throw new NetworkError(`X adapter does not implement "${action.action}".`, 400);
  },
};

/* --------------------------------------------------------------- Bluesky */

/** Bluesky uses a short-lived session from an app password rather than OAuth. */
async function bskySession(env, conn) {
  const host = conn.instance || "bsky.social";
  const d = await call(`https://${host}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA(env) },
    body: JSON.stringify({ identifier: conn.credentials.identifier, password: conn.credentials.appPassword }),
  }, "Bluesky");
  return { host, jwt: d.accessJwt, did: d.did };
}

const bluesky = {
  async publish(env, conn, item) {
    const s = await bskySession(env, conn);
    const record = {
      $type: "app.bsky.feed.post",
      text: item.text,
      createdAt: new Date().toISOString(),
      facets: linkFacets(item.text),
    };
    if (item.replyRef) record.reply = item.replyRef;
    const d = await call(`https://${s.host}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST", headers: bearer(s.jwt, env),
      body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record }),
    }, "Bluesky");
    const rkey = String(d.uri || "").split("/").pop();
    return { ok: true, remoteId: d.uri, url: rkey ? `https://bsky.app/profile/${s.did}/post/${rkey}` : null };
  },
  async act(env, conn, action) {
    const s = await bskySession(env, conn);
    if (action.action === "reply") {
      if (!action.targetId || !action.targetCid) {
        throw new NetworkError("Bluesky replies need the parent uri and cid.", 400);
      }
      const ref = { uri: action.targetId, cid: action.targetCid };
      return bluesky.publish(env, { ...conn }, {
        text: action.text,
        replyRef: { root: action.rootRef || ref, parent: ref },
      });
    }
    const collection = action.action === "repost" ? "app.bsky.feed.repost"
                     : action.action === "like" ? "app.bsky.feed.like" : null;
    if (!collection) throw new NetworkError(`Bluesky adapter does not implement "${action.action}".`, 400);
    await call(`https://${s.host}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST", headers: bearer(s.jwt, env),
      body: JSON.stringify({
        repo: s.did, collection,
        record: {
          $type: collection,
          subject: { uri: action.targetId, cid: action.targetCid },
          createdAt: new Date().toISOString(),
        },
      }),
    }, "Bluesky");
    return { ok: true };
  },
};

/** Bluesky needs links marked up explicitly or they render as plain text. */
function linkFacets(text) {
  const facets = [];
  const bytes = new TextEncoder().encode(text);
  const re = /https?:\/\/[^\s<>()]+/g;
  let m;
  while ((m = re.exec(text))) {
    const before = new TextEncoder().encode(text.slice(0, m.index)).length;
    facets.push({
      index: { byteStart: before, byteEnd: before + new TextEncoder().encode(m[0]).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  return facets.length ? facets : undefined;
}

/* -------------------------------------------------------------- Mastodon */

const mastodon = {
  async publish(env, conn, item) {
    const body = { status: item.text };
    if (item.replyTo) body.in_reply_to_id = item.replyTo;
    const d = await call(`https://${conn.instance}/api/v1/statuses`, {
      method: "POST",
      headers: { ...bearer(conn.accessToken, env), "Idempotency-Key": item.idempotencyKey || crypto.randomUUID() },
      body: JSON.stringify(body),
    }, "Mastodon");
    return { ok: true, remoteId: d.id, url: d.url };
  },
  async act(env, conn, action) {
    if (action.action === "reply") return mastodon.publish(env, conn, { text: action.text, replyTo: action.targetId });
    const path = action.action === "repost" ? "reblog" : action.action === "like" ? "favourite" : null;
    if (!path) throw new NetworkError(`Mastodon adapter does not implement "${action.action}".`, 400);
    const d = await call(`https://${conn.instance}/api/v1/statuses/${action.targetId}/${path}`, {
      method: "POST", headers: bearer(conn.accessToken, env),
    }, "Mastodon");
    return { ok: true, remoteId: d.id };
  },
};

/* -------------------------------------------------------------- LinkedIn */

const linkedin = {
  async publish(env, conn, item) {
    const author = conn.meta && conn.meta.remoteId
      ? (conn.meta.organizationUrn || `urn:li:person:${conn.meta.remoteId}`)
      : null;
    if (!author) throw new NetworkError("LinkedIn connection is missing the member id — reconnect it.", 400);
    const d = await call("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: { ...bearer(conn.accessToken, env), "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({
        author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: item.text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    }, "LinkedIn");
    const urn = d && d.id;
    return { ok: true, remoteId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
  },
};

/* -------------------------------------------------- Meta: Facebook Pages */

const facebook = {
  async publish(env, conn, item) {
    const pageId = conn.meta && conn.meta.pageId;
    const pageToken = conn.meta && conn.meta.pageToken;
    if (!pageId || !pageToken) throw new NetworkError("No Facebook Page is attached to this connection — reconnect it.", 400);
    const body = new URLSearchParams({ message: item.text, access_token: pageToken });
    if (item.media && item.media[0]) body.set("link", item.media[0]);
    const d = await call(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA(env) },
      body,
    }, "Facebook");
    return { ok: true, remoteId: d.id, url: d.id ? `https://facebook.com/${d.id}` : null };
  },
  async act(env, conn, action) {
    if (action.action !== "reply") throw new NetworkError(`Facebook adapter does not implement "${action.action}".`, 400);
    const pageToken = conn.meta.pageToken;
    const d = await call(`https://graph.facebook.com/v21.0/${action.targetId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA(env) },
      body: new URLSearchParams({ message: action.text, access_token: pageToken }),
    }, "Facebook");
    return { ok: true, remoteId: d.id };
  },
};

/* ------------------------------------------------------------- Instagram */

const instagram = {
  async publish(env, conn, item) {
    const igId = conn.meta && (conn.meta.igUserId || conn.meta.remoteId);
    if (!igId) throw new NetworkError("Instagram connection is missing the business account id — reconnect it.", 400);
    if (!item.media || !item.media[0]) throw new NetworkError("Instagram needs an image or video URL.", 400);

    // Instagram publishes in two steps: build a container, then publish it.
    const container = await call(`https://graph.instagram.com/v21.0/${igId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA(env) },
      body: new URLSearchParams({
        image_url: item.media[0],
        caption: item.text,
        access_token: conn.accessToken,
      }),
    }, "Instagram");

    const d = await call(`https://graph.instagram.com/v21.0/${igId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA(env) },
      body: new URLSearchParams({ creation_id: container.id, access_token: conn.accessToken }),
    }, "Instagram");
    return { ok: true, remoteId: d.id, url: null };
  },
};

/* --------------------------------------------------------------- Threads */

const threads = {
  async publish(env, conn, item) {
    const uid = conn.meta && (conn.meta.remoteId || "me");
    const container = await call(`https://graph.threads.net/v1.0/${uid}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA(env) },
      body: new URLSearchParams({
        media_type: item.media && item.media[0] ? "IMAGE" : "TEXT",
        ...(item.media && item.media[0] ? { image_url: item.media[0] } : {}),
        text: item.text,
        access_token: conn.accessToken,
      }),
    }, "Threads");
    const d = await call(`https://graph.threads.net/v1.0/${uid}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA(env) },
      body: new URLSearchParams({ creation_id: container.id, access_token: conn.accessToken }),
    }, "Threads");
    return { ok: true, remoteId: d.id, url: null };
  },
};

/* ---------------------------------------------------------------- Reddit */

const reddit = {
  async publish(env, conn, item) {
    const sr = item.target || (conn.meta && conn.meta.subreddit);
    if (!sr) throw new NetworkError("Reddit needs a target subreddit.", 400);
    const title = (item.title || item.text.split("\n")[0]).slice(0, 300);
    const d = await call("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA(env),
      },
      body: new URLSearchParams({
        sr: sr.replace(/^\/?r\//, ""), kind: "self", title, text: item.text, api_type: "json",
      }),
    }, "Reddit");
    const errs = d && d.json && d.json.errors;
    if (errs && errs.length) throw new NetworkError(`Reddit refused: ${errs[0].join(" ")}`, 400, d);
    const url = d && d.json && d.json.data && d.json.data.url;
    return { ok: true, remoteId: d && d.json && d.json.data && d.json.data.id, url };
  },
  async act(env, conn, action) {
    if (action.action !== "reply") throw new NetworkError(`Reddit adapter does not implement "${action.action}".`, 400);
    await call("https://oauth.reddit.com/api/comment", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA(env),
      },
      body: new URLSearchParams({ thing_id: action.targetId, text: action.text, api_type: "json" }),
    }, "Reddit");
    return { ok: true };
  },
};

/* -------------------------------------------------------------- Telegram */

const telegram = {
  async publish(env, conn, item) {
    const token = conn.credentials.botToken;
    const chat = item.target || conn.credentials.chatId;
    if (!chat) throw new NetworkError("Telegram needs a chat or channel id.", 400);
    const d = await call(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: item.text, disable_web_page_preview: false }),
    }, "Telegram");
    const id = d && d.result && d.result.message_id;
    return { ok: true, remoteId: id, url: null };
  },
  async act(env, conn, action) {
    if (action.action !== "reply") throw new NetworkError(`Telegram adapter does not implement "${action.action}".`, 400);
    const token = conn.credentials.botToken;
    await call(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: action.chatId || conn.credentials.chatId,
        text: action.text,
        reply_to_message_id: action.targetId,
      }),
    }, "Telegram");
    return { ok: true };
  },
};

/* --------------------------------------------------------------- Discord */

const discord = {
  async publish(env, conn, item) {
    const url = item.target || conn.credentials.webhookUrl;
    if (!url) throw new NetworkError("Discord needs a webhook URL.", 400);
    const res = await fetch(url + "?wait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: item.text.slice(0, 2000) }),
    });
    if (!res.ok) throw new NetworkError(`Discord error ${res.status}: ${(await res.text()).slice(0, 160)}`, res.status);
    const d = await res.json().catch(() => ({}));
    return { ok: true, remoteId: d.id, url: null };
  },
};

/* ------------------------------------------------------------- unsupported */

function unsupported(name, why) {
  return {
    async publish() {
      throw new NetworkError(`${name} is not wired up yet: ${why}`, 501);
    },
  };
}

export const ADAPTERS = {
  x, bluesky, mastodon, linkedin, facebook, instagram, threads, reddit, telegram, discord,
  tiktok: unsupported("TikTok", "video upload needs a chunked transfer and an audited app; add it when the account is approved."),
  youtube: unsupported("YouTube", "uploads need a resumable multipart transfer, which does not belong in a fan-out call."),
  pinterest: unsupported("Pinterest", "pins need a board id per account; add the board picker first."),
  tumblr: unsupported("Tumblr", "posts need the blog identifier; add it to the connection first."),
};

/**
 * Publish one item through whichever adapter its connection belongs to,
 * refreshing the token first if it is about to expire.
 */
export async function publishItem(env, conn, item) {
  const adapter = ADAPTERS[conn.platform];
  if (!adapter) throw new NetworkError(`No adapter for ${conn.platform}.`, 400);
  const fresh = await ensureFresh(env, conn);
  return adapter.publish(env, fresh, item);
}

export async function actItem(env, conn, action) {
  const adapter = ADAPTERS[conn.platform];
  if (!adapter || !adapter.act) {
    throw new NetworkError(`${conn.platform} does not support "${action.action}" here.`, 400);
  }
  const fresh = await ensureFresh(env, conn);
  return adapter.act(env, fresh, action);
}

export { NetworkError };
