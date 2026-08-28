/**
 * Network adapters.
 *
 * Pure request-shaping: each adapter takes a connection that already holds a
 * valid token and returns { ok, url, remoteId }, or throws with a message an
 * operator can act on. Refreshing tokens, storing them and deciding when to
 * send all happen in the caller — which is why the same file serves the
 * desktop app and the Worker's cron without either knowing about the other.
 *
 * Media arrives as an `io` helper rather than as bytes, because the two
 * callers get it from different places:
 *
 *   io.read(ref)      -> { name, type, size, bytes }  bytes for a direct upload
 *   io.publicUrl(ref) -> https URL                    for networks that fetch
 *                                                     the file themselves
 *   io.userAgent      -> string, required by Reddit
 */

export class NetworkError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "NetworkError";
    this.status = status;
    this.body = body;
  }
}

/* --------------------------------------------------------------- helpers */

async function call(url, options, label) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    throw new NetworkError(`${label} could not be reached: ${e.message}`, 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }

  if (!res.ok) {
    const detail = extractError(data) || text.slice(0, 200);
    if (res.status === 429) {
      const retry = res.headers.get("Retry-After") || res.headers.get("x-rate-limit-reset");
      throw new NetworkError(`${label} rate limit${retry ? ` — retry in ${retry}s` : ""}.`, 429, data);
    }
    if (res.status === 401 || res.status === 403) {
      throw new NetworkError(`${label} rejected the credentials (${res.status}): ${detail}`, res.status, data);
    }
    if (res.status === 413) throw new NetworkError(`${label} says the file is too large.`, 413, data);
    throw new NetworkError(`${label} error ${res.status}: ${detail}`, res.status, data);
  }
  return data;
}

function extractError(d) {
  if (!d) return null;
  return d.error_description || d.message ||
    (d.errors && d.errors[0] && (d.errors[0].message || d.errors[0].detail)) ||
    (d.error && (d.error.message || d.error.description || d.error)) ||
    (d.detail) || null;
}

const jsonHeaders = (token, io) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  ...(io && io.userAgent ? { "User-Agent": io.userAgent } : {}),
});

function need(condition, message) {
  if (!condition) throw new NetworkError(message, 400);
}

async function firstMedia(item, io) {
  const ref = (item.media || [])[0];
  if (!ref) return null;
  return io.read(ref);
}

function blobOf(file) {
  return new Blob([file.bytes], { type: file.type || "application/octet-stream" });
}

/* --------------------------------------------------------------------- X */

const x = {
  async publish(conn, item, io) {
    const body = { text: item.text };
    if (item.replyTo) body.reply = { in_reply_to_tweet_id: item.replyTo };

    if ((item.media || []).length) {
      const ids = [];
      for (const ref of item.media.slice(0, 4)) {
        ids.push(await x.upload(conn, await io.read(ref), io));
      }
      body.media = { media_ids: ids };
    }

    const d = await call("https://api.x.com/2/tweets", {
      method: "POST", headers: jsonHeaders(conn.accessToken, io), body: JSON.stringify(body),
    }, "X");
    const id = d && d.data && d.data.id;
    return { ok: true, remoteId: id, url: id ? `https://x.com/i/status/${id}` : null };
  },

  /** X's v2 media endpoint. Media is billed and gated separately from posts. */
  async upload(conn, file, io) {
    const form = new FormData();
    form.append("media", blobOf(file), file.name);
    form.append("media_category", (file.type || "").startsWith("video") ? "tweet_video" : "tweet_image");
    const d = await call("https://api.x.com/2/media/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${conn.accessToken}` },
      body: form,
    }, "X media upload");
    const id = (d && (d.id || (d.data && d.data.id))) || null;
    need(id, "X accepted the upload but returned no media id.");
    return id;
  },

  async act(conn, action, io) {
    const me = conn.meta && conn.meta.remoteId;
    need(me, "This X connection is missing the account id — reconnect it.");
    if (action.action === "reply") return x.publish(conn, { text: action.text, replyTo: action.targetId, media: action.media }, io);
    if (action.action === "quote") return x.publish(conn, { text: `${action.text} ${action.targetUrl || ""}`.trim() }, io);
    const path = action.action === "repost" ? "retweets" : action.action === "like" ? "likes" : null;
    need(path, `X adapter does not implement "${action.action}".`);
    await call(`https://api.x.com/2/users/${me}/${path}`, {
      method: "POST", headers: jsonHeaders(conn.accessToken, io),
      body: JSON.stringify({ tweet_id: action.targetId }),
    }, "X");
    return { ok: true };
  },
};

/* ------------------------------------------------------------- Instagram */

const instagram = {
  async publish(conn, item, io) {
    const igId = conn.meta && (conn.meta.igUserId || conn.meta.remoteId);
    need(igId, "This Instagram connection is missing the business account id — reconnect it.");
    need((item.media || []).length, "Instagram needs an image or video.");

    const base = "https://graph.instagram.com/v21.0";
    const token = conn.accessToken;

    // Meta fetches the file from a URL of ours; it never accepts bytes here.
    const urls = [];
    for (const ref of item.media.slice(0, 10)) urls.push(await io.publicUrl(ref));
    const isVideo = (u) => /\.(mp4|mov|m4v)(\?|$)/i.test(u);

    const container = async (params) => {
      const d = await call(`${base}/${igId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, access_token: token }),
      }, "Instagram");
      need(d && d.id, "Instagram did not return a media container.");
      return d.id;
    };

    let creationId;
    if (urls.length === 1) {
      creationId = await container(isVideo(urls[0])
        ? { media_type: "REELS", video_url: urls[0], caption: item.text }
        : { image_url: urls[0], caption: item.text });
    } else {
      const children = [];
      for (const u of urls) {
        children.push(await container(isVideo(u)
          ? { media_type: "VIDEO", video_url: u, is_carousel_item: "true" }
          : { image_url: u, is_carousel_item: "true" }));
      }
      creationId = await container({ media_type: "CAROUSEL", children: children.join(","), caption: item.text });
    }

    // Video containers are transcoded asynchronously; publishing early fails.
    await instagram.awaitReady(base, creationId, token, io);

    const d = await call(`${base}/${igId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: creationId, access_token: token }),
    }, "Instagram");
    return { ok: true, remoteId: d.id, url: null };
  },

  async awaitReady(base, creationId, token, io, tries = 30) {
    for (let i = 0; i < tries; i++) {
      const d = await call(`${base}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
        { method: "GET" }, "Instagram");
      if (d.status_code === "FINISHED") return;
      if (d.status_code === "ERROR" || d.status_code === "EXPIRED") {
        throw new NetworkError(`Instagram could not process the media: ${d.status || d.status_code}`, 400, d);
      }
      await sleep(io, 4000);
    }
    throw new NetworkError("Instagram is still processing the media after two minutes — try again shortly.", 504);
  },
};

/* ---------------------------------------------------------------- TikTok */

const tiktok = {
  async publish(conn, item, io) {
    const file = await firstMedia(item, io);
    need(file, "TikTok needs a video file.");

    // Unaudited apps may only publish privately. Claiming otherwise would put a
    // client's post somewhere they cannot see it and call it published.
    const privacy = conn.meta && conn.meta.audited ? (item.privacy || "PUBLIC_TO_EVERYONE") : "SELF_ONLY";

    const init = await call("https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST", headers: jsonHeaders(conn.accessToken, io),
      body: JSON.stringify({
        post_info: {
          title: (item.text || "").slice(0, 2200),
          privacy_level: privacy,
          disable_comment: !!item.disableComment,
          disable_duet: !!item.disableDuet,
          disable_stitch: !!item.disableStitch,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: file.size,
          chunk_size: file.size,
          total_chunk_count: 1,
        },
      }),
    }, "TikTok");

    const data = init && init.data;
    need(data && data.upload_url, "TikTok did not return an upload URL.");

    const put = await fetch(data.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "video/mp4",
        "Content-Range": `bytes 0-${file.size - 1}/${file.size}`,
      },
      body: file.bytes,
    });
    if (!put.ok) throw new NetworkError(`TikTok upload failed (${put.status}).`, put.status);

    return {
      ok: true,
      remoteId: data.publish_id,
      url: null,
      privacy,
      note: privacy === "SELF_ONLY"
        ? "Posted privately — TikTok restricts unaudited apps to SELF_ONLY."
        : undefined,
    };
  },
};

/* -------------------------------------------------------- Facebook Pages */

const facebook = {
  async publish(conn, item, io) {
    const pageId = conn.meta && conn.meta.pageId;
    const pageToken = conn.meta && conn.meta.pageToken;
    need(pageId && pageToken, "No Facebook Page is attached to this connection — reconnect it.");
    const base = `https://graph.facebook.com/v21.0/${pageId}`;

    const file = await firstMedia(item, io);
    if (!file) {
      const d = await call(`${base}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ message: item.text, access_token: pageToken }),
      }, "Facebook");
      return { ok: true, remoteId: d.id, url: d.id ? `https://facebook.com/${d.id}` : null };
    }

    const isVideo = (file.type || "").startsWith("video");
    const form = new FormData();
    form.append("access_token", pageToken);
    form.append(isVideo ? "description" : "caption", item.text || "");
    form.append("source", blobOf(file), file.name);
    const d = await call(`${base}/${isVideo ? "videos" : "photos"}`, { method: "POST", body: form }, "Facebook");
    const id = d.post_id || d.id;
    return { ok: true, remoteId: id, url: id ? `https://facebook.com/${id}` : null };
  },

  async act(conn, action, io) {
    need(action.action === "reply", `Facebook adapter does not implement "${action.action}".`);
    const d = await call(`https://graph.facebook.com/v21.0/${action.targetId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: action.text, access_token: conn.meta.pageToken }),
    }, "Facebook");
    return { ok: true, remoteId: d.id };
  },
};

/* -------------------------------------------------------------- Telegram */

const telegram = {
  async publish(conn, item, io) {
    const token = conn.credentials.botToken;
    const chat = item.target || conn.credentials.chatId;
    need(chat, "Telegram needs a chat or channel id.");
    const api = (m) => `https://api.telegram.org/bot${token}/${m}`;

    const files = [];
    for (const ref of (item.media || []).slice(0, 10)) files.push(await io.read(ref));

    if (!files.length) {
      const d = await call(api("sendMessage"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: item.text }),
      }, "Telegram");
      return { ok: true, remoteId: d.result && d.result.message_id, url: null };
    }

    if (files.length === 1) {
      const f = files[0];
      const isVideo = (f.type || "").startsWith("video");
      const form = new FormData();
      form.append("chat_id", String(chat));
      form.append("caption", (item.text || "").slice(0, 1024));
      form.append(isVideo ? "video" : "photo", blobOf(f), f.name);
      const d = await call(api(isVideo ? "sendVideo" : "sendPhoto"), { method: "POST", body: form }, "Telegram");
      return { ok: true, remoteId: d.result && d.result.message_id, url: null };
    }

    const form = new FormData();
    form.append("chat_id", String(chat));
    form.append("media", JSON.stringify(files.map((f, i) => ({
      type: (f.type || "").startsWith("video") ? "video" : "photo",
      media: `attach://f${i}`,
      ...(i === 0 ? { caption: (item.text || "").slice(0, 1024) } : {}),
    }))));
    files.forEach((f, i) => form.append(`f${i}`, blobOf(f), f.name));
    const d = await call(api("sendMediaGroup"), { method: "POST", body: form }, "Telegram");
    return { ok: true, remoteId: d.result && d.result[0] && d.result[0].message_id, url: null };
  },

  async act(conn, action, io) {
    need(action.action === "reply", `Telegram adapter does not implement "${action.action}".`);
    await call(`https://api.telegram.org/bot${conn.credentials.botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
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
  async publish(conn, item, io) {
    const hook = item.target || conn.credentials.webhookUrl;
    need(hook, "Discord needs a webhook URL.");
    const files = [];
    for (const ref of (item.media || []).slice(0, 10)) files.push(await io.read(ref));

    let options;
    if (files.length) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ content: (item.text || "").slice(0, 2000) }));
      files.forEach((f, i) => form.append(`files[${i}]`, blobOf(f), f.name));
      options = { method: "POST", body: form };
    } else {
      options = {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: (item.text || "").slice(0, 2000) }),
      };
    }
    const d = await call(hook + (hook.includes("?") ? "&" : "?") + "wait=true", options, "Discord");
    return { ok: true, remoteId: d && d.id, url: null };
  },
};

/* ---------------------------------------------------------------- Reddit */

const reddit = {
  async publish(conn, item, io) {
    const sr = String(item.target || (conn.meta && conn.meta.subreddit) || "").replace(/^\/?r\//, "");
    need(sr, "Reddit needs a target subreddit.");
    const title = (item.title || (item.text || "").split("\n")[0] || "").slice(0, 300);
    need(title, "Reddit needs a title.");

    const form = { sr, title, api_type: "json", kind: "self", text: item.text };
    if ((item.media || []).length) {
      // Reddit's own media hosting needs a separate lease flow; linking to the
      // hosted copy posts the image without pretending it was uploaded there.
      form.kind = "link";
      form.url = await io.publicUrl(item.media[0]);
      delete form.text;
    }

    const d = await call("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": io.userAgent,
      },
      body: new URLSearchParams(form),
    }, "Reddit");

    const errs = d && d.json && d.json.errors;
    if (errs && errs.length) throw new NetworkError(`Reddit refused: ${errs[0].join(" ")}`, 400, d);
    const out = (d && d.json && d.json.data) || {};
    return { ok: true, remoteId: out.id, url: out.url };
  },

  async act(conn, action, io) {
    need(action.action === "reply", `Reddit adapter does not implement "${action.action}".`);
    await call("https://oauth.reddit.com/api/comment", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": io.userAgent,
      },
      body: new URLSearchParams({ thing_id: action.targetId, text: action.text, api_type: "json" }),
    }, "Reddit");
    return { ok: true };
  },
};

/* ---------------------------------------------------------------- Tumblr */

const tumblr = {
  async publish(conn, item, io) {
    const blog = item.target || (conn.meta && conn.meta.blogIdentifier);
    need(blog, "Tumblr needs a blog identifier.");
    const url = `https://api.tumblr.com/v2/blog/${encodeURIComponent(blog)}/posts`;

    const content = [];
    if (item.text) content.push({ type: "text", text: item.text });

    const files = [];
    for (const ref of (item.media || []).slice(0, 10)) files.push(await io.read(ref));
    files.forEach((f, i) => {
      content.push({
        type: (f.type || "").startsWith("video") ? "video" : "image",
        media: [{ type: f.type, identifier: `media${i}` }],
      });
    });

    const payload = { content, state: item.draft ? "draft" : "published", tags: (item.tags || []).join(",") };

    let options;
    if (files.length) {
      const form = new FormData();
      form.append("json", new Blob([JSON.stringify(payload)], { type: "application/json" }));
      files.forEach((f, i) => form.append(`media${i}`, blobOf(f), f.name));
      options = { method: "POST", headers: { Authorization: `Bearer ${conn.accessToken}` }, body: form };
    } else {
      options = { method: "POST", headers: jsonHeaders(conn.accessToken, io), body: JSON.stringify(payload) };
    }

    const d = await call(url, options, "Tumblr");
    const id = d && d.response && (d.response.id_string || d.response.id);
    return { ok: true, remoteId: id, url: id ? `https://${blog}/post/${id}` : null };
  },

  async act(conn, action, io) {
    need(action.action === "repost", `Tumblr adapter does not implement "${action.action}".`);
    const blog = action.target || conn.meta.blogIdentifier;
    await call(`https://api.tumblr.com/v2/blog/${encodeURIComponent(blog)}/post/reblog`, {
      method: "POST", headers: jsonHeaders(conn.accessToken, io),
      body: JSON.stringify({ id: action.targetId, reblog_key: action.reblogKey, comment: action.text }),
    }, "Tumblr");
    return { ok: true };
  },
};

/* ------------------------------------------------------------- WordPress */

const wordpress = {
  /** Application Passwords authenticate as Basic; there is no OAuth app. */
  auth(conn) {
    const { username, appPassword } = conn.credentials || {};
    need(username && appPassword, "This WordPress connection is missing its username or application password.");
    const raw = `${username}:${String(appPassword).replace(/\s+/g, "")}`;
    const b64 = typeof btoa === "function" ? btoa(raw) : Buffer.from(raw, "utf8").toString("base64");
    return `Basic ${b64}`;
  },

  site(conn, item) {
    const site = String(item.target || (conn.credentials && conn.credentials.siteUrl) || "").replace(/\/+$/, "");
    need(site, "WordPress needs the site URL.");
    return `${site}/wp-json/wp/v2`;
  },

  async publish(conn, item, io) {
    const api = wordpress.site(conn, item);
    const auth = wordpress.auth(conn);

    let featured = null;
    const file = await firstMedia(item, io);
    if (file) {
      const d = await call(`${api}/media`, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Disposition": `attachment; filename="${file.name}"`,
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file.bytes,
      }, "WordPress media");
      featured = d && d.id;
    }

    const title = (item.title || (item.text || "").split("\n")[0] || "Untitled").slice(0, 200);
    const d = await call(`${api}/posts`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        content: item.html || toHtml(item.text),
        status: item.draft ? "draft" : "publish",
        ...(featured ? { featured_media: featured } : {}),
        ...(item.categories ? { categories: item.categories } : {}),
        ...(item.wpTags ? { tags: item.wpTags } : {}),
      }),
    }, "WordPress");
    return { ok: true, remoteId: d.id, url: d.link };
  },

  async act(conn, action, io) {
    need(action.action === "reply", `WordPress adapter does not implement "${action.action}".`);
    const api = wordpress.site(conn, action);
    const d = await call(`${api}/comments`, {
      method: "POST",
      headers: { Authorization: wordpress.auth(conn), "Content-Type": "application/json" },
      body: JSON.stringify({ post: action.targetId, content: action.text }),
    }, "WordPress");
    return { ok: true, remoteId: d.id, url: d.link };
  },
};

function toHtml(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

/* ----------------------------------------------------------------- Vimeo */

const vimeo = {
  async publish(conn, item, io) {
    const file = await firstMedia(item, io);
    need(file, "Vimeo needs a video file.");
    const headers = {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: "application/vnd.vimeo.*+json;version=3.4",
      "Content-Type": "application/json",
    };

    // tus: create the slot, then push bytes to the returned link. Resumable,
    // which matters when a client's 4 GB master goes over a domestic uplink.
    const created = await call("https://api.vimeo.com/me/videos", {
      method: "POST", headers,
      body: JSON.stringify({
        upload: { approach: "tus", size: String(file.size) },
        name: (item.title || (item.text || "").split("\n")[0] || file.name).slice(0, 128),
        description: item.text || "",
        privacy: { view: item.privacy || "anybody" },
      }),
    }, "Vimeo");

    const link = created && created.upload && created.upload.upload_link;
    need(link, "Vimeo did not return an upload link.");

    const chunkSize = 32 * 1024 * 1024;
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + chunkSize, file.size);
      const res = await fetch(link, {
        method: "PATCH",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
        },
        body: file.bytes.slice(offset, end),
      });
      if (!res.ok) throw new NetworkError(`Vimeo upload failed at ${offset} bytes (${res.status}).`, res.status);
      const next = Number(res.headers.get("Upload-Offset"));
      // Trust the server's offset: a short write must not be counted as sent.
      offset = Number.isFinite(next) && next > offset ? next : end;
      if (io.onProgress) io.onProgress({ sent: offset, total: file.size });
    }

    return { ok: true, remoteId: created.uri, url: created.link || null };
  },
};

/* ------------------------------------------------------------- Pinterest */

const pinterest = {
  async publish(conn, item, io) {
    const board = item.target || (conn.meta && conn.meta.boardId);
    need(board, "Pinterest needs a board id.");
    const file = await firstMedia(item, io);
    need(file, "Pinterest needs an image.");

    const media_source = file.url
      ? { source_type: "image_url", url: file.url }
      : { source_type: "image_base64", content_type: file.type || "image/jpeg", data: toBase64(file.bytes) };

    const d = await call("https://api.pinterest.com/v5/pins", {
      method: "POST", headers: jsonHeaders(conn.accessToken, io),
      body: JSON.stringify({
        board_id: board,
        title: (item.title || "").slice(0, 100) || undefined,
        description: (item.text || "").slice(0, 800),
        link: item.link || undefined,
        media_source,
      }),
    }, "Pinterest");
    return { ok: true, remoteId: d.id, url: d.id ? `https://pinterest.com/pin/${d.id}` : null };
  },
};

function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* --------------------------------------------------------------- Bluesky */

async function bskySession(conn) {
  const host = conn.instance || "bsky.social";
  const d = await call(`https://${host}/xrpc/com.atproto.server.createSession`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: conn.credentials.identifier, password: conn.credentials.appPassword }),
  }, "Bluesky");
  return { host, jwt: d.accessJwt, did: d.did };
}

const bluesky = {
  async publish(conn, item, io) {
    const s = await bskySession(conn);
    const record = {
      $type: "app.bsky.feed.post",
      text: item.text,
      createdAt: new Date().toISOString(),
      facets: linkFacets(item.text),
    };
    if (item.replyRef) record.reply = item.replyRef;

    const images = [];
    for (const ref of (item.media || []).slice(0, 4)) {
      const f = await io.read(ref);
      const blob = await call(`https://${s.host}/xrpc/com.atproto.repo.uploadBlob`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.jwt}`, "Content-Type": f.type || "image/jpeg" },
        body: f.bytes,
      }, "Bluesky upload");
      images.push({ alt: item.alt || "", image: blob.blob });
    }
    if (images.length) record.embed = { $type: "app.bsky.embed.images", images };

    const d = await call(`https://${s.host}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST", headers: jsonHeaders(s.jwt, io),
      body: JSON.stringify({ repo: s.did, collection: "app.bsky.feed.post", record }),
    }, "Bluesky");
    const rkey = String(d.uri || "").split("/").pop();
    return { ok: true, remoteId: d.uri, url: rkey ? `https://bsky.app/profile/${s.did}/post/${rkey}` : null };
  },

  async act(conn, action, io) {
    const s = await bskySession(conn);
    if (action.action === "reply") {
      need(action.targetId && action.targetCid, "Bluesky replies need the parent uri and cid.");
      const ref = { uri: action.targetId, cid: action.targetCid };
      return bluesky.publish(conn, { text: action.text, replyRef: { root: action.rootRef || ref, parent: ref } }, io);
    }
    const collection = action.action === "repost" ? "app.bsky.feed.repost"
                     : action.action === "like" ? "app.bsky.feed.like" : null;
    need(collection, `Bluesky adapter does not implement "${action.action}".`);
    await call(`https://${s.host}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST", headers: jsonHeaders(s.jwt, io),
      body: JSON.stringify({
        repo: s.did, collection,
        record: { $type: collection, subject: { uri: action.targetId, cid: action.targetCid }, createdAt: new Date().toISOString() },
      }),
    }, "Bluesky");
    return { ok: true };
  },
};

function linkFacets(text) {
  const encoder = new TextEncoder();
  const facets = [];
  const re = /https?:\/\/[^\s<>()]+/g;
  let m;
  while ((m = re.exec(text || ""))) {
    const start = encoder.encode(text.slice(0, m.index)).length;
    facets.push({
      index: { byteStart: start, byteEnd: start + encoder.encode(m[0]).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    });
  }
  return facets.length ? facets : undefined;
}

/* -------------------------------------------------------------- Mastodon */

const mastodon = {
  async publish(conn, item, io) {
    const ids = [];
    for (const ref of (item.media || []).slice(0, 4)) {
      const f = await io.read(ref);
      const form = new FormData();
      form.append("file", blobOf(f), f.name);
      const d = await call(`https://${conn.instance}/api/v2/media`, {
        method: "POST", headers: { Authorization: `Bearer ${conn.accessToken}` }, body: form,
      }, "Mastodon upload");
      ids.push(d.id);
    }
    const body = { status: item.text };
    if (item.replyTo) body.in_reply_to_id = item.replyTo;
    if (ids.length) body.media_ids = ids;

    const d = await call(`https://${conn.instance}/api/v1/statuses`, {
      method: "POST",
      headers: { ...jsonHeaders(conn.accessToken, io), "Idempotency-Key": item.idempotencyKey || randomKey() },
      body: JSON.stringify(body),
    }, "Mastodon");
    return { ok: true, remoteId: d.id, url: d.url };
  },

  async act(conn, action, io) {
    if (action.action === "reply") return mastodon.publish(conn, { text: action.text, replyTo: action.targetId }, io);
    const path = action.action === "repost" ? "reblog" : action.action === "like" ? "favourite" : null;
    need(path, `Mastodon adapter does not implement "${action.action}".`);
    const d = await call(`https://${conn.instance}/api/v1/statuses/${action.targetId}/${path}`, {
      method: "POST", headers: jsonHeaders(conn.accessToken, io),
    }, "Mastodon");
    return { ok: true, remoteId: d.id };
  },
};

/* -------------------------------------------------------------- LinkedIn */

const linkedin = {
  async publish(conn, item, io) {
    const author = conn.meta && conn.meta.remoteId
      ? (conn.meta.organizationUrn || `urn:li:person:${conn.meta.remoteId}`)
      : null;
    need(author, "This LinkedIn connection is missing the member id — reconnect it.");
    const d = await call("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: { ...jsonHeaders(conn.accessToken, io), "X-Restli-Protocol-Version": "2.0.0" },
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
    return { ok: true, remoteId: d.id, url: d.id ? `https://www.linkedin.com/feed/update/${d.id}` : null };
  },
};

/* ------------------------------------------------------------------ misc */

function randomKey() {
  return (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(36).slice(2);
}

function sleep(io, ms) {
  if (io && io.sleep) return io.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

export const ADAPTERS = {
  x, instagram, tiktok, facebook, telegram, discord, reddit, tumblr,
  wordpress, vimeo, pinterest, bluesky, mastodon, linkedin,
};

/** Publish one item. `conn` must already carry a valid token. */
export async function publish(conn, item, io) {
  const adapter = ADAPTERS[conn.platform];
  if (!adapter) throw new NetworkError(`No adapter for ${conn.platform}.`, 400);
  return adapter.publish(conn, item, withDefaults(io));
}

/** Carry out a rule action (reply, repost, like). */
export async function act(conn, action, io) {
  const adapter = ADAPTERS[conn.platform];
  if (!adapter || !adapter.act) {
    throw new NetworkError(`${conn.platform} does not support "${action.action}" here.`, 400);
  }
  return adapter.act(conn, action, withDefaults(io));
}

function withDefaults(io) {
  return {
    userAgent: "broadcast-desk/1.0",
    read: async () => { throw new NetworkError("This send needs media, but no media reader was provided.", 500); },
    publicUrl: async () => { throw new NetworkError("This network fetches media from a URL, but no media host is configured.", 500); },
    ...(io || {}),
  };
}
